use std::cell::RefCell;
use std::rc::Rc;

use libghostty_vt::key::{self, Key as GKey, Mods};
use libghostty_vt::render::{CellIterator, CursorVisualStyle, Dirty, RowIterator};
use libghostty_vt::screen::CellWide;
use libghostty_vt::search::Search;
use libghostty_vt::style::{Palette, RgbColor, StyleColor, Underline};
use libghostty_vt::terminal::{Mode, Point, PointCoordinate, ScrollViewport};
use libghostty_vt::{RenderState, Terminal, mouse, paste};
use rune::{Color, Key, KeyEvent, PhysicalKeyCode, Span};

pub const FG: RgbColor = RgbColor {
    r: 0xe9,
    g: 0xe9,
    b: 0xf0,
};
pub const BG: RgbColor = RgbColor {
    r: 0x0d,
    g: 0x0d,
    b: 0x13,
};
const SCROLLBACK: usize = 10_000;

const fn rgb(v: u32) -> RgbColor {
    RgbColor {
        r: (v >> 16) as u8,
        g: (v >> 8) as u8,
        b: v as u8,
    }
}

pub const FG_LIGHT: RgbColor = rgb(0x1f2328);
pub const BG_LIGHT: RgbColor = rgb(0xffffff);
const LIGHT_ANSI: [u32; 16] = [
    0x24292f, 0xcf222e, 0x116329, 0x4d2d00, 0x0969da, 0x8250df, 0x1b7c83, 0x6e7781, 0x57606a,
    0xa40e26, 0x1a7f37, 0x633c01, 0x218bff, 0xa475f9, 0x3192aa, 0x8c959f,
];

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum DecoKind {
    Single,
    Double,
    Curly,
    Dotted,
    Dashed,
    Over,
    Strike,
}

#[derive(Clone, Copy, PartialEq, Debug)]
pub struct Deco {
    pub a: u16,
    pub b: u16,
    pub kind: DecoKind,
    pub color: Color,
}

#[derive(Clone, Default)]
pub struct Line {
    pub text: String,
    pub spans: Vec<Span>,
    /// Cell backgrounds as column runs `[start, end)`, painted as full-height rectangles: a span
    /// background only covers the glyphs' ascent and descent, which leaves a gap between rows.
    pub bgs: Vec<(u16, u16, Color)>,
    pub decos: Vec<Deco>,
    /// Column runs carrying an OSC 8 hyperlink.
    pub links: Vec<(u16, u16)>,
    /// Byte offset in `text` where each terminal column starts (a wide glyph's tail column
    /// repeats its head's offset); columns past the trimmed end fall beyond `text.len()`.
    pub cols: Vec<usize>,
    pub version: u64,
}

impl Line {
    /// Byte range of terminal columns `a..b` in `text`, padded past the end with spaces.
    pub fn byte_range(&self, a: u16, b: u16) -> (usize, usize) {
        let at = |c: u16| -> usize {
            let c = c as usize;
            match self.cols.get(c) {
                Some(&o) if o <= self.text.len() => o,
                _ => {
                    self.text.len()
                        + c.saturating_sub(
                            self.cols.iter().filter(|&&o| o < self.text.len()).count(),
                        )
                }
            }
        };
        (at(a), at(b).max(at(a)))
    }

    pub fn slice(&self, a: u16, b: u16) -> String {
        let (x, y) = self.byte_range(a, b);
        let end = y.min(self.text.len());
        if x >= end {
            String::new()
        } else {
            self.text[x..end].to_string()
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum CursorShape {
    Block,
    Hollow,
    Bar,
    Underline,
}

#[derive(Clone, Copy)]
pub struct CursorAt {
    pub x: u16,
    pub y: u16,
    pub shape: CursorShape,
    pub color: Color,
    pub blinking: bool,
}

/// One shell's screen, parsed by Ghostty's VT core and kept as styled lines for Rune.
pub struct Vt {
    search: Option<Search<'static, 'static>>,
    terminal: Terminal<'static, 'static>,
    render: RenderState<'static>,
    row_iter: RowIterator<'static>,
    cell_iter: CellIterator<'static>,
    replies: Rc<RefCell<Vec<u8>>>,
    bells: Rc<std::cell::Cell<u32>>,
    clips: Rc<RefCell<Vec<String>>>,
    keys: key::Encoder<'static>,
    pub lines: Vec<Line>,
    pub cursor: Option<CursorAt>,
    pub background: Color,
    pub foreground: Color,
    pub title: String,
    pub cell: (f32, f32),
    version: u64,
    dark: bool,
    dark_palette: Option<Palette>,
}

pub fn color(c: RgbColor) -> Color {
    rune::color::hex(&format!("#{:02x}{:02x}{:02x}", c.r, c.g, c.b)).unwrap_or(Color::WHITE)
}

impl Vt {
    pub fn new(cols: u16, rows: u16) -> Option<Vt> {
        let replies = Rc::new(RefCell::new(Vec::new()));
        let bells = Rc::new(std::cell::Cell::new(0));
        let clips = Rc::new(RefCell::new(Vec::new()));
        let mut terminal = Terminal::new(cols, rows).ok()?;
        terminal
            .on_clipboard_write({
                let clips = Rc::clone(&clips);
                move |_, w| {
                    if let Some(text) = clipboard_text(&w) {
                        clips.borrow_mut().push(text);
                    }
                    w.reply(Ok(()), false);
                }
            })
            .ok()?;
        terminal
            .on_bell({
                let bells = Rc::clone(&bells);
                move |_| bells.set(bells.get() + 1)
            })
            .ok()?;
        terminal
            .on_pty_write({
                let replies = Rc::clone(&replies);
                move |_, bytes| replies.borrow_mut().extend_from_slice(bytes)
            })
            .ok()?;
        terminal.set_scrollback_max_lines(Some(SCROLLBACK)).ok()?;
        terminal.set_default_fg_color(Some(FG)).ok()?;
        terminal.set_default_bg_color(Some(BG)).ok()?;
        let mut vt = Vt {
            search: None,
            terminal,
            render: RenderState::new().ok()?,
            row_iter: RowIterator::new().ok()?,
            cell_iter: CellIterator::new().ok()?,
            replies,
            bells,
            clips,
            keys: key::Encoder::new().ok()?,
            lines: Vec::new(),
            cursor: None,
            background: color(BG),
            foreground: color(FG),
            title: String::new(),
            cell: (7.2, 18.0),
            version: 0,
            dark: true,
            dark_palette: None,
        };
        vt.refresh();
        Some(vt)
    }

    /// Feeds shell output; returns what the terminal answers back (device attributes, cursor
    /// reports…), which belongs on the shell's input.
    pub fn write(&mut self, bytes: &[u8]) -> Vec<u8> {
        self.terminal.vt_write(bytes);
        self.refresh();
        std::mem::take(&mut *self.replies.borrow_mut())
    }

    /// Looks for `needle` across the scrollback and selects the newest match; returns
    /// `(matches, selected index)`.
    pub fn search(&mut self, needle: &str) -> (usize, Option<usize>) {
        if needle.is_empty() {
            self.end_search();
            return (0, None);
        }
        if self.search.is_none() {
            self.search = Search::new(&mut self.terminal).ok();
        }
        let Some(search) = self.search.as_mut() else {
            return (0, None);
        };
        let _ = search.set_needle(&mut self.terminal, needle.as_bytes());
        let _ = search.run(&mut self.terminal);
        let _ = search.select_next(&mut self.terminal);
        let found = (
            search.total_matches().unwrap_or(0),
            search.selected_index().ok().flatten(),
        );
        self.refresh();
        found
    }

    /// The next match toward older output (`older`) or newer, scrolling to it.
    pub fn search_step(&mut self, older: bool) -> (usize, Option<usize>) {
        let Some(search) = self.search.as_mut() else {
            return (0, None);
        };
        let _ = search.run(&mut self.terminal);
        let _ = if older {
            search.select_next(&mut self.terminal)
        } else {
            search.select_prev(&mut self.terminal)
        };
        let found = (
            search.total_matches().unwrap_or(0),
            search.selected_index().ok().flatten(),
        );
        self.refresh();
        found
    }

    pub fn end_search(&mut self) {
        self.search = None;
    }

    /// Bells rung since the last call.
    /// The last text a program put on the clipboard (OSC 52) since the previous call.
    pub fn take_clipboard(&mut self) -> Option<String> {
        let mut clips = self.clips.borrow_mut();
        let last = clips.pop();
        clips.clear();
        last
    }

    /// The screen row at the top of the viewport.
    pub fn viewport_top(&self) -> u64 {
        self.scroll_position().map_or(0, |(offset, _, _)| offset)
    }

    /// The text from one screen cell to another, inclusive, across the scrollback.
    pub fn text_between(&self, a: (u16, u64), b: (u16, u64)) -> Option<String> {
        use libghostty_vt::fmt::{Format, Formatter};
        use libghostty_vt::selection::Selection;
        let at = |(x, y): (u16, u64)| {
            self.terminal.grid_ref(Point::Screen(PointCoordinate {
                x,
                y: u32::try_from(y).unwrap_or(u32::MAX),
            }))
        };
        let sel = Selection::new(at(a).ok()?, at(b).ok()?, false);
        self.terminal.set_selection(Some(&sel)).ok()?;
        let text = Formatter::new_selection(&self.terminal)
            .ok()
            .flatten()
            .and_then(|mut f| {
                f.set_format(Format::Plain)
                    .ok()?
                    .set_unwrap(true)
                    .ok()?
                    .set_trim(true)
                    .ok()?;
                let bytes = f.format_alloc(None).ok()?;
                Some(String::from_utf8_lossy(&bytes).into_owned())
            });
        let _ = self.terminal.set_selection(None);
        text
    }

    /// The OSC 8 target under a viewport cell.
    pub fn hyperlink_at(&self, x: u16, y: u16) -> Option<String> {
        let r = self
            .terminal
            .grid_ref(Point::Viewport(PointCoordinate { x, y: u32::from(y) }))
            .ok()?;
        let mut buf = vec![0u8; 2048];
        let n = r.hyperlink_uri(&mut buf).ok()?;
        (n > 0).then(|| String::from_utf8_lossy(&buf[..n]).into_owned())
    }

    /// CSI I / CSI O for a program that asked to hear focus changes (mode 1004).
    pub fn focus_report(&self, gained: bool) -> Option<Vec<u8>> {
        if !self.terminal.mode(Mode::FOCUS_EVENT).unwrap_or(false) {
            return None;
        }
        let ev = if gained {
            libghostty_vt::focus::Event::Gained
        } else {
            libghostty_vt::focus::Event::Lost
        };
        let mut buf = [0u8; 8];
        let n = ev.encode(&mut buf).ok()?;
        Some(buf[..n].to_vec())
    }

    /// Default colours for the app's theme: a light ground and ANSI colours readable on it.
    pub fn set_dark(&mut self, dark: bool) {
        if self.dark == dark {
            return;
        }
        self.dark = dark;
        if self.dark_palette.is_none() {
            self.dark_palette = self.terminal.default_color_palette().ok();
        }
        let (fg, bg) = if dark { (FG, BG) } else { (FG_LIGHT, BG_LIGHT) };
        let _ = self.terminal.set_default_fg_color(Some(fg));
        let _ = self.terminal.set_default_bg_color(Some(bg));
        let palette = if dark {
            self.dark_palette
        } else {
            self.dark_palette.map(|Palette(mut p)| {
                for (i, v) in LIGHT_ANSI.iter().enumerate() {
                    p[i] = rgb(*v);
                }
                Palette(p)
            })
        };
        let _ = self.terminal.set_default_color_palette(palette);
        self.lines.clear();
        self.refresh();
    }

    pub fn take_bells(&mut self) -> u32 {
        self.bells.replace(0)
    }

    /// `(rows above the viewport, viewport rows, total rows)` when there is scrollback.
    pub fn scroll_position(&self) -> Option<(u64, u64, u64)> {
        let sb = self.terminal.scrollbar().ok()?;
        (sb.total > sb.len).then_some((sb.offset, sb.len, sb.total))
    }

    pub fn size(&self) -> (u16, u16) {
        (
            self.terminal.cols().unwrap_or(80),
            self.terminal.rows().unwrap_or(24),
        )
    }

    pub fn resize(&mut self, cols: u16, rows: u16, cell: (f32, f32)) {
        self.cell = cell;
        let _ = self
            .terminal
            .resize(cols, rows, cell.0.round() as u32, cell.1.round() as u32);
        self.refresh();
    }

    pub fn scroll(&mut self, rows: isize) {
        self.terminal.scroll_viewport(ScrollViewport::Delta(rows));
        self.refresh();
    }

    pub fn scroll_to_bottom(&mut self) {
        self.terminal.scroll_viewport(ScrollViewport::Bottom);
        self.refresh();
    }

    pub fn mouse_tracking(&self) -> bool {
        self.terminal.is_mouse_tracking().unwrap_or(false)
    }

    /// Re-reads the rows Ghostty marked dirty; untouched rows keep their version so the view
    /// reuses them.
    fn refresh(&mut self) {
        let Ok(snapshot) = self.render.update(&self.terminal) else {
            return;
        };
        let dirty = snapshot.dirty().unwrap_or(Dirty::Full);
        let rows = snapshot.rows().unwrap_or(0) as usize;
        let full = dirty == Dirty::Full || self.lines.len() != rows;
        if self.lines.len() != rows {
            self.lines.resize_with(rows, Line::default);
        }
        let colors = snapshot.colors().ok();
        let (fg, bg) = colors
            .as_ref()
            .map_or((FG, BG), |c| (c.foreground, c.background));
        self.background = color(bg);
        self.foreground = color(fg);
        self.cursor = None;
        if snapshot.cursor_visible().unwrap_or(false)
            && let Ok(Some(at)) = snapshot.cursor_viewport()
        {
            let shape = match snapshot
                .cursor_visual_style()
                .unwrap_or(CursorVisualStyle::Block)
            {
                CursorVisualStyle::Bar => CursorShape::Bar,
                CursorVisualStyle::Underline => CursorShape::Underline,
                CursorVisualStyle::BlockHollow => CursorShape::Hollow,
                _ => CursorShape::Block,
            };
            let c = colors.as_ref().and_then(|c| c.cursor).unwrap_or(fg);
            self.cursor = Some(CursorAt {
                x: at.x,
                y: at.y,
                shape,
                color: color(c),
                blinking: snapshot.cursor_blinking().unwrap_or(false),
            });
        }
        if dirty == Dirty::Clean && !full {
            return;
        }
        let _ = snapshot.set_dirty(Dirty::Clean);
        let Ok(mut rows_it) = self.row_iter.update(&snapshot) else {
            return;
        };
        let mut y = 0usize;
        while let Some(row) = rows_it.next() {
            let row_dirty = full || row.dirty().unwrap_or(true);
            let _ = row.set_dirty(false);
            if !row_dirty || y >= self.lines.len() {
                y += 1;
                continue;
            }
            let mut text = String::new();
            let mut spans: Vec<Span> = Vec::new();
            let mut cols: Vec<usize> = Vec::new();
            let mut bgs: Vec<(u16, u16, Color)> = Vec::new();
            let mut decos: Vec<Deco> = Vec::new();
            let mut links: Vec<(u16, u16)> = Vec::new();
            if let Ok(mut cells) = self.cell_iter.update(row) {
                let mut graphemes = String::new();
                while let Some(cell) = cells.next() {
                    if cell
                        .raw_cell()
                        .and_then(|r| r.wide())
                        .is_ok_and(|w| w == CellWide::SpacerTail)
                    {
                        let col = cols.len() as u16;
                        if let Some(run) = bgs.last_mut().filter(|r| r.1 == col) {
                            run.1 = col + 1;
                        }
                        cols.push(cols.last().copied().unwrap_or(text.len()));
                        continue;
                    }
                    let col = cols.len() as u16;
                    cols.push(text.len());
                    graphemes.clear();
                    let _ = cell.graphemes_utf8(&mut graphemes);
                    let start = text.len();
                    text.push_str(if graphemes.is_empty() {
                        " "
                    } else {
                        &graphemes
                    });
                    let end = text.len();
                    let style = cell.style().ok();
                    let mut cfg = cell.fg_color().ok().flatten();
                    let mut cbg = cell.bg_color().ok().flatten();
                    if cell
                        .raw_cell()
                        .and_then(|r| r.has_hyperlink())
                        .unwrap_or(false)
                    {
                        match links.last_mut() {
                            Some(run) if run.1 == col => run.1 = col + 1,
                            _ => links.push((col, col + 1)),
                        }
                    }
                    let (bold, italic, faint, inverse) =
                        style.as_ref().map_or((false, false, false, false), |s| {
                            (s.bold, s.italic, s.faint, s.inverse)
                        });
                    if inverse {
                        (cfg, cbg) = (Some(cbg.unwrap_or(bg)), Some(cfg.unwrap_or(fg)));
                    }
                    if let Some(st) = style.as_ref() {
                        let ink = color(cfg.unwrap_or(fg));
                        let under = match st.underline_color {
                            StyleColor::Rgb(c) => color(c),
                            StyleColor::Palette(i) => colors
                                .as_ref()
                                .map_or(ink, |c| color(c.palette[i.0 as usize])),
                            StyleColor::None => ink,
                        };
                        let kind = match st.underline {
                            Underline::Single => Some(DecoKind::Single),
                            Underline::Double => Some(DecoKind::Double),
                            Underline::Curly => Some(DecoKind::Curly),
                            Underline::Dotted => Some(DecoKind::Dotted),
                            Underline::Dashed => Some(DecoKind::Dashed),
                            _ => None,
                        };
                        let marks = [
                            kind.map(|k| (k, under)),
                            st.overline.then_some((DecoKind::Over, ink)),
                            st.strikethrough.then_some((DecoKind::Strike, ink)),
                        ];
                        for (kind, c) in marks.into_iter().flatten() {
                            match decos
                                .iter_mut()
                                .rev()
                                .find(|d| d.kind == kind && d.b == col && d.color == c)
                            {
                                Some(d) => d.b = col + 1,
                                None => decos.push(Deco {
                                    a: col,
                                    b: col + 1,
                                    kind,
                                    color: c,
                                }),
                            }
                        }
                    }
                    if let Some(b) = cbg.map(color) {
                        match bgs.last_mut() {
                            Some(run) if run.1 == col && run.2 == b => run.1 = col + 1,
                            _ => bgs.push((col, col + 1, b)),
                        }
                    }
                    if cfg.is_none() && !bold && !italic && !faint {
                        continue;
                    }
                    let mut sp = Span::new(start, end);
                    let ink = cfg.map(color).unwrap_or_else(|| color(fg));
                    if cfg.is_some() || faint {
                        sp = sp.color(if faint { ink.alpha(0.6) } else { ink });
                    }
                    if bold {
                        sp = sp.bold();
                    }
                    if italic {
                        sp = sp.italic();
                    }
                    match spans.last_mut() {
                        Some(last) if last.end as usize == start && same_look(last, &sp) => {
                            last.end = end as u32
                        }
                        _ => spans.push(sp),
                    }
                }
            }
            if spans.last().is_none_or(|s| (s.end as usize) < text.len()) {
                let keep = spans.last().map_or(0, |s| s.end as usize);
                let trimmed = text[keep..].trim_end().len();
                text.truncate(keep + trimmed);
            }
            self.version += 1;
            self.lines[y] = Line {
                text,
                spans,
                bgs,
                decos,
                links,
                cols,
                version: self.version,
            };
            y += 1;
        }
        if let Ok(t) = self.terminal.title() {
            self.title = String::from_utf8_lossy(t).into_owned();
        }
    }

    /// Encodes a key the way Ghostty would for this terminal's current modes.
    #[cfg(test)]
    pub fn encode_key(
        &mut self,
        ev: &KeyEvent,
        physical: Option<PhysicalKeyCode>,
    ) -> Option<Vec<u8>> {
        self.encode_key_action(ev, physical, key::Action::Press)
    }

    /// A press, repeat or release; releases and repeats only reach programs that asked for
    /// them through the kitty keyboard protocol, the encoder drops them otherwise.
    pub fn encode_key_action(
        &mut self,
        ev: &KeyEvent,
        physical: Option<PhysicalKeyCode>,
        action: key::Action,
    ) -> Option<Vec<u8>> {
        let gkey = physical
            .map(physical_to_ghostty)
            .unwrap_or(GKey::Unidentified);
        let gkey = if gkey == GKey::Unidentified {
            logical_to_ghostty(&ev.key)
        } else {
            gkey
        };
        let mut mods = Mods::empty();
        if ev.mods.shift {
            mods |= Mods::SHIFT;
        }
        if ev.mods.alt {
            mods |= Mods::ALT;
        }
        if ev.mods.ctrl {
            mods |= Mods::CTRL;
        }
        let text = match &ev.key {
            Key::Text(t)
                if action != key::Action::Release
                    && !ev.mods.ctrl
                    && !t.chars().any(char::is_control) =>
            {
                Some(t.clone())
            }
            _ => None,
        };
        if gkey == GKey::Unidentified && text.is_none() {
            return None;
        }
        let mut event = key::Event::new().ok()?;
        event
            .set_action(action)
            .set_key(gkey)
            .set_mods(mods)
            .set_utf8(text.clone());
        let typed = match &ev.key {
            Key::Text(t) => t.chars().next().filter(|c| !c.is_control()),
            _ => None,
        };
        if let Some(c) = typed {
            event.set_unshifted_codepoint(c.to_ascii_lowercase());
        } else if let Some(c) = unshifted(gkey) {
            event.set_unshifted_codepoint(c);
        }
        self.keys
            .set_options_from_terminal(&self.terminal)
            .set_macos_option_as_alt(key::OptionAsAlt::Left);
        let mut out = Vec::new();
        self.keys.encode_to_vec(&event, &mut out).ok()?;
        (!out.is_empty()).then_some(out)
    }

    pub fn encode_paste(&self, text: &str) -> Vec<u8> {
        let bracketed = self.terminal.mode(Mode::BRACKETED_PASTE).unwrap_or(false);
        let mut data = text.as_bytes().to_vec();
        let mut buf = vec![0u8; data.len() * 2 + 16];
        match paste::encode(&mut data, bracketed, &mut buf) {
            Ok(n) => buf[..n].to_vec(),
            Err(_) => text.as_bytes().to_vec(),
        }
    }

    /// A button press, release or drag in the form the program asked for, else None.
    pub fn encode_mouse(
        &self,
        action: mouse::Action,
        button: Option<mouse::Button>,
        x: f32,
        y: f32,
        shift: bool,
    ) -> Option<Vec<u8>> {
        if !self.mouse_tracking() {
            return None;
        }
        let (cols, rows) = self.size();
        let (cw, ch) = (self.cell.0.max(1.0), self.cell.1.max(1.0));
        let mut enc = mouse::Encoder::new().ok()?;
        let _ = enc
            .set_options_from_terminal(&self.terminal)
            .set_any_button_pressed(button.is_some() && action == mouse::Action::Motion)
            .set_size(mouse::EncoderSize {
                screen_width: (f32::from(cols) * cw) as u32,
                screen_height: (f32::from(rows) * ch) as u32,
                cell_width: cw as u32,
                cell_height: ch as u32,
                padding_top: 0,
                padding_bottom: 0,
                padding_left: 0,
                padding_right: 0,
            });
        let mut ev = mouse::Event::new().ok()?;
        ev.set_action(action)
            .set_button(button)
            .set_position(mouse::Position { x, y });
        if shift {
            ev.set_mods(Mods::SHIFT);
        }
        let mut out = Vec::new();
        enc.encode_to_vec(&ev, &mut out).ok()?;
        (!out.is_empty()).then_some(out)
    }

    /// A wheel notch as the program asked to receive it (mouse tracking on), else None.
    pub fn encode_wheel(&self, up: bool, x: f32, y: f32) -> Option<Vec<u8>> {
        if !self.mouse_tracking() {
            return None;
        }
        let (cols, rows) = self.size();
        let (cw, ch) = (self.cell.0.max(1.0) as u32, self.cell.1.max(1.0) as u32);
        let mut enc = mouse::Encoder::new().ok()?;
        let _ = enc
            .set_options_from_terminal(&self.terminal)
            .set_size(mouse::EncoderSize {
                screen_width: u32::from(cols) * cw,
                screen_height: u32::from(rows) * ch,
                cell_width: cw,
                cell_height: ch,
                padding_top: 0,
                padding_bottom: 0,
                padding_left: 0,
                padding_right: 0,
            });
        let mut ev = mouse::Event::new().ok()?;
        ev.set_action(mouse::Action::Press)
            .set_button(Some(if up {
                mouse::Button::Four
            } else {
                mouse::Button::Five
            }))
            .set_position(mouse::Position { x, y });
        let mut out = Vec::new();
        enc.encode_to_vec(&ev, &mut out).ok()?;
        (!out.is_empty()).then_some(out)
    }
}

fn clipboard_text(w: &libghostty_vt::terminal::ClipboardWrite<'_>) -> Option<String> {
    // libghostty-rs exposes no accessor for the written contents; the wrapper is a lone raw
    // pointer to the C request, so read it through that pointer.
    const _: () = assert!(
        std::mem::size_of::<libghostty_vt::terminal::ClipboardWrite<'static>>()
            == std::mem::size_of::<*const libghostty_vt::ffi::ClipboardWrite>()
    );
    let raw: *const libghostty_vt::ffi::ClipboardWrite = unsafe { std::mem::transmute_copy(w) };
    let req = unsafe { raw.as_ref()? };
    if req.contents.is_null() {
        return None;
    }
    let contents = unsafe { std::slice::from_raw_parts(req.contents, req.contents_len) };
    let bytes = |s: &libghostty_vt::ffi::String| {
        if s.ptr.is_null() {
            &[][..]
        } else {
            unsafe { std::slice::from_raw_parts(s.ptr, s.len) }
        }
    };
    contents
        .iter()
        .find(|c| bytes(&c.mime).starts_with(b"text/plain"))
        .or(contents.first())
        .map(|c| String::from_utf8_lossy(bytes(&c.data)).into_owned())
}

fn same_look(a: &Span, b: &Span) -> bool {
    a.underline == b.underline && same_ink(a, b)
}

fn same_ink(a: &Span, b: &Span) -> bool {
    a.color == b.color && a.bg == b.bg && a.weight == b.weight && a.italic == b.italic
}

fn unshifted(k: GKey) -> Option<char> {
    Some(match k {
        GKey::Space => ' ',
        GKey::Enter => '\r',
        GKey::Tab => '\t',
        _ => return None,
    })
}

fn logical_to_ghostty(k: &Key) -> GKey {
    match k {
        Key::Enter => GKey::Enter,
        Key::Backspace => GKey::Backspace,
        Key::Delete => GKey::Delete,
        Key::Left => GKey::ArrowLeft,
        Key::Right => GKey::ArrowRight,
        Key::Up => GKey::ArrowUp,
        Key::Down => GKey::ArrowDown,
        Key::Home => GKey::Home,
        Key::End => GKey::End,
        Key::PageUp => GKey::PageUp,
        Key::PageDown => GKey::PageDown,
        Key::Insert => GKey::Insert,
        Key::Escape => GKey::Escape,
        Key::Tab => GKey::Tab,
        _ => GKey::Unidentified,
    }
}

fn physical_to_ghostty(code: PhysicalKeyCode) -> GKey {
    use PhysicalKeyCode as P;
    match code {
        P::KeyA => GKey::A,
        P::KeyB => GKey::B,
        P::KeyC => GKey::C,
        P::KeyD => GKey::D,
        P::KeyE => GKey::E,
        P::KeyF => GKey::F,
        P::KeyG => GKey::G,
        P::KeyH => GKey::H,
        P::KeyI => GKey::I,
        P::KeyJ => GKey::J,
        P::KeyK => GKey::K,
        P::KeyL => GKey::L,
        P::KeyM => GKey::M,
        P::KeyN => GKey::N,
        P::KeyO => GKey::O,
        P::KeyP => GKey::P,
        P::KeyQ => GKey::Q,
        P::KeyR => GKey::R,
        P::KeyS => GKey::S,
        P::KeyT => GKey::T,
        P::KeyU => GKey::U,
        P::KeyV => GKey::V,
        P::KeyW => GKey::W,
        P::KeyX => GKey::X,
        P::KeyY => GKey::Y,
        P::KeyZ => GKey::Z,
        P::Digit0 => GKey::Digit0,
        P::Digit1 => GKey::Digit1,
        P::Digit2 => GKey::Digit2,
        P::Digit3 => GKey::Digit3,
        P::Digit4 => GKey::Digit4,
        P::Digit5 => GKey::Digit5,
        P::Digit6 => GKey::Digit6,
        P::Digit7 => GKey::Digit7,
        P::Digit8 => GKey::Digit8,
        P::Digit9 => GKey::Digit9,
        P::Backquote => GKey::Backquote,
        P::Backslash => GKey::Backslash,
        P::BracketLeft => GKey::BracketLeft,
        P::BracketRight => GKey::BracketRight,
        P::Comma => GKey::Comma,
        P::Equal => GKey::Equal,
        P::Minus => GKey::Minus,
        P::Period => GKey::Period,
        P::Quote => GKey::Quote,
        P::Semicolon => GKey::Semicolon,
        P::Slash => GKey::Slash,
        P::IntlBackslash => GKey::IntlBackslash,
        P::Backspace => GKey::Backspace,
        P::Enter => GKey::Enter,
        P::Space => GKey::Space,
        P::Tab => GKey::Tab,
        P::Delete => GKey::Delete,
        P::End => GKey::End,
        P::Home => GKey::Home,
        P::Insert => GKey::Insert,
        P::PageDown => GKey::PageDown,
        P::PageUp => GKey::PageUp,
        P::ArrowDown => GKey::ArrowDown,
        P::ArrowLeft => GKey::ArrowLeft,
        P::ArrowRight => GKey::ArrowRight,
        P::ArrowUp => GKey::ArrowUp,
        P::Escape => GKey::Escape,
        P::F1 => GKey::F1,
        P::F2 => GKey::F2,
        P::F3 => GKey::F3,
        P::F4 => GKey::F4,
        P::F5 => GKey::F5,
        P::F6 => GKey::F6,
        P::F7 => GKey::F7,
        P::F8 => GKey::F8,
        P::F9 => GKey::F9,
        P::F10 => GKey::F10,
        P::F11 => GKey::F11,
        P::F12 => GKey::F12,
        P::Numpad0 => GKey::Numpad0,
        P::Numpad1 => GKey::Numpad1,
        P::Numpad2 => GKey::Numpad2,
        P::Numpad3 => GKey::Numpad3,
        P::Numpad4 => GKey::Numpad4,
        P::Numpad5 => GKey::Numpad5,
        P::Numpad6 => GKey::Numpad6,
        P::Numpad7 => GKey::Numpad7,
        P::Numpad8 => GKey::Numpad8,
        P::Numpad9 => GKey::Numpad9,
        P::NumpadAdd => GKey::NumpadAdd,
        P::NumpadDecimal => GKey::NumpadDecimal,
        P::NumpadDivide => GKey::NumpadDivide,
        P::NumpadEnter => GKey::NumpadEnter,
        P::NumpadMultiply => GKey::NumpadMultiply,
        P::NumpadSubtract => GKey::NumpadSubtract,
        _ => GKey::Unidentified,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rune::Mods as RMods;

    fn ev(key: Key, ctrl: bool) -> KeyEvent {
        KeyEvent {
            key,
            mods: RMods {
                ctrl,
                ..Default::default()
            },
        }
    }

    #[test]
    fn links_and_search_reach_the_scrollback() {
        let mut vt = Vt::new(40, 3).expect("terminal");
        vt.write(b"see https://example.com/a?b=1). ok\r\n");
        let l = links(&vt.lines[0]);
        assert_eq!(l.len(), 1);
        assert_eq!(l[0].2, "https://example.com/a?b=1");
        assert_eq!((l[0].0, l[0].1), (4, 29));
        vt.write(b"needle here\r\n");
        for i in 0..20 {
            vt.write(format!("line {i}\r\n").as_bytes());
        }
        assert!(vt.lines.iter().all(|l| matches(l, "needle").is_empty()));
        let (n, _) = vt.search("NEEDLE");
        assert_eq!(n, 1);
        assert!(vt.lines.iter().any(|l| matches(l, "needle") == [(0, 6)]));
    }

    #[test]
    fn releases_and_repeats_only_reach_kitty_programs() {
        let mut vt = Vt::new(20, 3).expect("terminal");
        let a = KeyEvent {
            key: Key::Text("a".into()),
            mods: rune::Mods::default(),
        };
        let k = Some(PhysicalKeyCode::KeyA);
        let up = vt.encode_key_action(&a, k, key::Action::Release);
        assert_eq!(up, None);
        vt.write(b"\x1b[>11u");
        let up = vt
            .encode_key_action(&a, k, key::Action::Release)
            .expect("release");
        assert!(String::from_utf8_lossy(&up).ends_with(":3u"), "{up:?}");
        let rep = vt
            .encode_key_action(&a, k, key::Action::Repeat)
            .expect("repeat");
        assert!(String::from_utf8_lossy(&rep).contains(":2"), "{rep:?}");
    }

    #[test]
    fn osc52_and_text_across_the_scrollback() {
        let mut vt = Vt::new(10, 3).expect("terminal");
        vt.write(b"\x1b]52;c;aGVsbG8=\x07");
        assert_eq!(vt.take_clipboard().as_deref(), Some("hello"));
        assert_eq!(vt.take_clipboard(), None);
        vt.write(b"one\r\ntwo\r\nthree\r\nfour\r\nfive");
        let top = vt.viewport_top();
        assert_eq!(top, 2);
        assert_eq!(vt.text_between((0, 0), (2, 1)).as_deref(), Some("one\ntwo"));
        assert_eq!(
            vt.text_between((1, 1), (3, 4)).as_deref(),
            Some("wo\nthree\nfour\nfive")
        );
    }

    #[test]
    fn decorations_links_and_focus_reports() {
        let mut vt = Vt::new(40, 3).expect("terminal");
        vt.write(b"\x1b[4:3mab\x1b[0m \x1b[9mcd\x1b[0m \x1b]8;;https://x.y\x1b\\go\x1b]8;;\x1b\\");
        let kinds: Vec<(DecoKind, u16, u16)> = vt.lines[0]
            .decos
            .iter()
            .map(|d| (d.kind, d.a, d.b))
            .collect();
        assert_eq!(kinds, [(DecoKind::Curly, 0, 2), (DecoKind::Strike, 3, 5)]);
        assert_eq!(vt.lines[0].links, [(6, 8)]);
        assert_eq!(vt.hyperlink_at(6, 0).as_deref(), Some("https://x.y"));
        assert_eq!(vt.hyperlink_at(0, 0), None);
        assert_eq!(vt.focus_report(true), None);
        vt.write(b"\x1b[?1004h");
        assert_eq!(vt.focus_report(true).as_deref(), Some(&b"\x1b[I"[..]));
        assert_eq!(vt.focus_report(false).as_deref(), Some(&b"\x1b[O"[..]));
    }

    #[test]
    fn output_becomes_styled_lines() {
        let mut vt = Vt::new(20, 3).expect("terminal");
        vt.write(b"hi \x1b[1;31mred\x1b[0m\r\nnext");
        assert_eq!(vt.lines[0].text, "hi red");
        assert!(
            vt.lines[0]
                .spans
                .iter()
                .any(|s| s.start == 3 && s.end == 6 && s.color.is_some())
        );
        assert_eq!(vt.lines[1].text, "next");
        let c = vt.cursor.expect("cursor");
        assert_eq!((c.x, c.y), (4, 1));
    }

    #[test]
    fn backgrounds_are_column_runs() {
        let mut vt = Vt::new(20, 3).expect("terminal");
        vt.write(b"ab\x1b[41mcde\x1b[0mf\x1b[44m\xe6\x97\xa5\x1b[0m");
        let l = &vt.lines[0];
        assert_eq!(l.bgs.len(), 2);
        assert_eq!((l.bgs[0].0, l.bgs[0].1), (2, 5));
        assert_eq!((l.bgs[1].0, l.bgs[1].1), (6, 8));
        assert!(l.spans.iter().all(|s| s.bg.is_none()));
    }

    #[test]
    fn untouched_rows_keep_their_version() {
        let mut vt = Vt::new(20, 3).expect("terminal");
        vt.write(b"one\r\ntwo");
        let first = vt.lines[0].version;
        vt.write(b"!");
        assert_eq!(vt.lines[0].version, first);
        assert_eq!(vt.lines[1].text, "two!");
    }

    #[test]
    fn keys_follow_the_terminal_modes() {
        let mut vt = Vt::new(20, 3).expect("terminal");
        assert_eq!(
            vt.encode_key(&ev(Key::Up, false), Some(PhysicalKeyCode::ArrowUp)),
            Some(b"\x1b[A".to_vec())
        );
        vt.write(b"\x1b[?1h");
        assert_eq!(
            vt.encode_key(&ev(Key::Up, false), Some(PhysicalKeyCode::ArrowUp)),
            Some(b"\x1bOA".to_vec())
        );
        assert_eq!(
            vt.encode_key(
                &ev(Key::Text("c".into()), true),
                Some(PhysicalKeyCode::KeyC)
            ),
            Some(vec![3])
        );
        assert_eq!(
            vt.encode_key(&ev(Key::Text("é".into()), false), None),
            Some("é".as_bytes().to_vec())
        );
    }

    #[test]
    fn queries_get_answered() {
        let mut vt = Vt::new(20, 3).expect("terminal");
        let reply = vt.write(b"\x1b[6n");
        assert_eq!(reply, b"\x1b[1;1R");
    }

    #[test]
    fn columns_map_to_bytes_across_wide_glyphs() {
        let mut vt = Vt::new(20, 2).expect("terminal");
        vt.write("a日b".as_bytes());
        let l = &vt.lines[0];
        assert_eq!(l.slice(0, 1), "a");
        assert_eq!(l.slice(1, 3), "日");
        assert_eq!(l.slice(3, 4), "b");
        assert_eq!(l.byte_range(6, 7), (l.text.len() + 2, l.text.len() + 3));
    }

    #[test]
    fn clicks_reach_programs_that_track_the_mouse() {
        let mut vt = Vt::new(20, 3).expect("terminal");
        assert!(
            vt.encode_mouse(
                mouse::Action::Press,
                Some(mouse::Button::Left),
                1.0,
                1.0,
                false
            )
            .is_none()
        );
        vt.write(b"\x1b[?1000h\x1b[?1006h");
        let b = vt
            .encode_mouse(
                mouse::Action::Press,
                Some(mouse::Button::Left),
                1.0,
                1.0,
                false,
            )
            .expect("press");
        assert_eq!(b, b"\x1b[<0;1;1M");
    }

    #[test]
    fn paste_is_bracketed_when_asked() {
        let mut vt = Vt::new(20, 3).expect("terminal");
        assert_eq!(vt.encode_paste("ls"), b"ls");
        vt.write(b"\x1b[?2004h");
        assert_eq!(vt.encode_paste("ls"), b"\x1b[200~ls\x1b[201~");
    }
}

fn col_of(line: &Line, byte: usize) -> u16 {
    line.cols
        .iter()
        .position(|&o| o >= byte)
        .unwrap_or(line.cols.len()) as u16
}

/// Plain `http(s)://` URLs on a line, as column ranges `[a, b)` with the URL.
pub fn links(line: &Line) -> Vec<(u16, u16, String)> {
    let t = &line.text;
    let mut out = Vec::new();
    let mut from = 0;
    while let Some(i) = ["https://", "http://"]
        .iter()
        .filter_map(|p| t[from..].find(p).map(|i| from + i))
        .min()
    {
        let rest = &t[i..];
        let mut end = rest
            .find(|c: char| c.is_whitespace() || "\"'<>`|".contains(c))
            .unwrap_or(rest.len());
        while end > 0 && rest[..end].ends_with(['.', ',', ';', ':', ')', ']', '}', '!', '?']) {
            if rest[..end].ends_with(')') && rest[..end].contains('(') {
                break;
            }
            end -= 1;
        }
        if end > "http://".len() {
            out.push((
                col_of(line, i),
                col_of(line, i + end),
                rest[..end].to_string(),
            ));
        }
        from = i + end.max(1);
    }
    out
}

/// Occurrences of `needle` on a line, ignoring case, as column ranges `[a, b)`.
pub fn matches(line: &Line, needle: &str) -> Vec<(u16, u16)> {
    if needle.is_empty() {
        return Vec::new();
    }
    let hay = line.text.to_lowercase();
    let n = needle.to_lowercase();
    if hay.len() != line.text.len() {
        return Vec::new();
    }
    hay.match_indices(&n)
        .map(|(i, m)| (col_of(line, i), col_of(line, i + m.len())))
        .collect()
}
