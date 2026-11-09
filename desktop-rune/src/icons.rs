use rune::Icon;

macro_rules! lucide {
    ($id:ident, $name:literal, $body:literal) => {
        pub static $id: Icon = Icon {
            name: concat!("hooked-", $name),
            view: 24.0,
            body: concat!(
                r#"<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">"#,
                $body,
                "</g>"
            ),
        };
    };
}

lucide!(
    DECK,
    "deck",
    r#"<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>"#
);
lucide!(
    SEARCH,
    "search",
    r#"<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>"#
);
lucide!(PLUS, "plus", r#"<path d="M12 5v14M5 12h14"/>"#);
lucide!(
    BELL,
    "bell",
    r#"<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>"#
);
lucide!(
    BELL_OFF,
    "bell-off",
    r#"<path d="M8.7 3A6 6 0 0 1 18 8c0 2.3.4 4 .9 5.3M18 8c0 7 3 9 3 9H7M10.3 21a1.94 1.94 0 0 0 3.4 0"/><path d="M2 2l20 20"/>"#
);
lucide!(
    SUN,
    "sun",
    r#"<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>"#
);
lucide!(
    MOON,
    "moon",
    r#"<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9z"/>"#
);
lucide!(
    MONITOR,
    "monitor",
    r#"<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/>"#
);
lucide!(
    ARROW_LEFT,
    "arrow-left",
    r#"<path d="M19 12H5M12 19l-7-7 7-7"/>"#
);
lucide!(
    ARROW_RIGHT,
    "arrow-right",
    r#"<path d="M5 12h14M12 5l7 7-7 7"/>"#
);
lucide!(ARROW_UP, "arrow-up", r#"<path d="M12 19V5M5 12l7-7 7 7"/>"#);
lucide!(
    ARCHIVE,
    "archive",
    r#"<rect x="2" y="3" width="20" height="5" rx="1"/><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8M10 12h4"/>"#
);
lucide!(
    UNARCHIVE,
    "unarchive",
    r#"<rect x="2" y="3" width="20" height="5" rx="1"/><path d="M4 8v11a2 2 0 0 0 2 2h2M20 8v11a2 2 0 0 1-2 2h-2M9 15l3-3 3 3M12 12v9"/>"#
);
lucide!(
    CLOCK,
    "clock",
    r#"<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>"#
);
lucide!(
    FOLDER,
    "folder",
    r#"<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>"#
);
lucide!(
    LIST,
    "list",
    r#"<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>"#
);
lucide!(
    MORE,
    "more",
    r#"<circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>"#
);
lucide!(
    GIT_BRANCH,
    "git-branch",
    r#"<path d="M6 3v12"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/>"#
);
lucide!(ZAP, "zap", r#"<path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z"/>"#);
lucide!(PLAY, "play", r#"<path d="m6 3 14 9-14 9V3z"/>"#);
lucide!(
    STOP,
    "stop",
    r#"<rect x="6" y="6" width="12" height="12" rx="1"/>"#
);
lucide!(
    USER,
    "user",
    r#"<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>"#
);
lucide!(
    BOT,
    "bot",
    r#"<path d="M12 8V4H8"/><rect x="4" y="8" width="16" height="12" rx="2"/><path d="M2 14h2M20 14h2M15 13v2M9 13v2"/>"#
);
lucide!(
    TOOL,
    "tool",
    r#"<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>"#
);
lucide!(DIFF, "diff", r#"<path d="M12 3v14M5 10h14M5 21h14"/>"#);
lucide!(
    TASKS,
    "tasks",
    r#"<path d="m3 17 2 2 4-4M3 7l2 2 4-4M13 6h8M13 12h8M13 18h8"/>"#
);
lucide!(
    LINK,
    "link",
    r#"<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>"#
);
lucide!(
    TRASH,
    "trash",
    r#"<path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>"#
);
lucide!(
    RESTART,
    "restart",
    r#"<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>"#
);
lucide!(CODE, "code", r#"<path d="m16 18 6-6-6-6M8 6l-6 6 6 6"/>"#);
lucide!(
    COPY,
    "copy",
    r#"<rect x="8" y="8" width="14" height="14" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>"#
);
lucide!(
    CONVERSE,
    "converse",
    r#"<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>"#
);
lucide!(
    SHIP,
    "ship",
    r#"<path d="M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/>"#
);
lucide!(
    PLUG,
    "plug",
    r#"<path d="M12 22v-5M9 8V2M15 8V2M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z"/>"#
);
lucide!(
    ACTIVITY,
    "activity",
    r#"<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>"#
);
lucide!(
    SIDEBAR,
    "sidebar",
    r#"<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 3v18"/>"#
);
lucide!(
    PANEL_RIGHT,
    "panel-right",
    r#"<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M15 3v18"/>"#
);
lucide!(CIRCLE, "circle", r#"<circle cx="12" cy="12" r="9"/>"#);
lucide!(
    CIRCLE_DOT,
    "circle-dot",
    r#"<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3" fill="currentColor"/>"#
);
lucide!(
    CIRCLE_CHECK,
    "circle-check",
    r#"<circle cx="12" cy="12" r="9"/><path d="m8.5 12 2.5 2.5 5-5"/>"#
);
lucide!(
    CHART,
    "chart",
    r#"<path d="M3 3v18h18"/><path d="M7 16v-4M12 16V8M17 16v-7"/>"#
);
lucide!(
    BOOK,
    "book",
    r#"<path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20"/>"#
);
lucide!(
    BRAIN,
    "brain",
    r#"<path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z"/><path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z"/>"#
);
lucide!(
    TIMER,
    "timer",
    r#"<path d="M10 2h4M12 14l3-3"/><circle cx="12" cy="14" r="8"/>"#
);
lucide!(
    GEAR,
    "gear",
    r#"<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>"#
);
lucide!(CLOSE, "close", r#"<path d="M18 6 6 18M6 6l12 12"/>"#);
lucide!(
    IMAGE,
    "image",
    r#"<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21"/>"#
);
lucide!(
    GITHUB,
    "github",
    r#"<path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.403 5.403 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4"/><path d="M9 18c-4.51 2-5-2-7-2"/>"#
);
lucide!(
    SPLIT,
    "split",
    r#"<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M12 3v18"/>"#
);
lucide!(
    SWAP,
    "swap",
    r#"<path d="m16 3 4 4-4 4M20 7H4M8 21l-4-4 4-4M4 17h16"/>"#
);
lucide!(TERMINAL, "terminal", r#"<path d="m4 17 6-6-6-6M12 19h8"/>"#);
lucide!(CHEVRON_DOWN, "chevron-down", r#"<path d="m6 9 6 6 6-6"/>"#);
lucide!(
    EYE,
    "eye",
    r#"<path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>"#
);
lucide!(
    EYE_OFF,
    "eye-off",
    r#"<path d="M9.88 9.88a3 3 0 1 0 4.24 4.24M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61M2 2l20 20"/>"#
);
lucide!(
    TAG,
    "tag",
    r#"<path d="M12 2H2v10l9.29 9.29a1 1 0 0 0 1.41 0l8.59-8.59a1 1 0 0 0 0-1.41Z"/><circle cx="7" cy="7" r="1.5"/>"#
);
lucide!(
    FORK,
    "fork",
    r#"<circle cx="6" cy="6" r="3"/><circle cx="18" cy="6" r="3"/><circle cx="12" cy="18" r="3"/><path d="M6 9v1a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V9M12 12v3"/>"#
);
lucide!(
    SPARKLE,
    "sparkle",
    r#"<path d="M12 3l1.9 5.8L20 10.7l-6.1 1.9L12 18.5l-1.9-5.9L4 10.7l6.1-1.9Z"/>"#
);
lucide!(MINUS, "minus", r#"<path d="M5 12h14"/>"#);
lucide!(
    PIN,
    "pin",
    r#"<path d="M12 17v5M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/>"#
);
lucide!(
    SORT,
    "sort",
    r#"<path d="m3 16 4 4 4-4M7 20V4M11 4h10M11 8h7M11 12h4"/>"#
);
