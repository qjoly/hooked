package dev.qjoly.hooked.ui.kit

import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MenuDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.RectangleShape
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.PathParser
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.DpOffset
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.material3.Icon as M3Icon

/** A Lucide glyph: 24 viewbox, stroke 2, round caps and joins, painted in the tint. */
fun lucide(name: String, vararg paths: String): ImageVector {
    val b = ImageVector.Builder(name, 24.dp, 24.dp, 24f, 24f)
    for (d in paths) {
        b.addPath(
            pathData = PathParser().parsePathString(d).toNodes(),
            fill = null,
            stroke = SolidColor(Color.Black),
            strokeLineWidth = 2f,
            strokeLineCap = StrokeCap.Round,
            strokeLineJoin = StrokeJoin.Round,
        )
    }
    return b.build()
}

@Composable
fun KIcon(icon: ImageVector, tint: Color, size: Dp = 16.dp, modifier: Modifier = Modifier, label: String? = null) =
    M3Icon(icon, label, modifier.size(size), tint = tint)

enum class Variant { NEUTRAL, GHOST, GHOST_MUTED, GHOST_FAINT, OUTLINE, CONTRAST, WARNING, DANGER }

enum class Size(val h: Dp, val px: Dp, val icon: Dp, val square: Dp, val squareIcon: Dp) {
    MINI(16.dp, 8.dp, 12.dp, 16.dp, 12.dp),
    SMALL(20.dp, 10.dp, 14.dp, 20.dp, 16.dp),
    REGULAR(24.dp, 12.dp, 16.dp, 24.dp, 16.dp),
    LARGE(28.dp, 14.dp, 16.dp, 28.dp, 16.dp),
    XL(36.dp, 18.dp, 16.dp, 36.dp, 18.dp),
}

@Composable
private fun radiusFor(size: Size, square: Boolean = false): Dp = when (size) {
    Size.MINI, Size.SMALL -> k.r.sm
    Size.REGULAR -> k.r.md
    Size.LARGE -> if (square) k.r.md else k.r.lg
    Size.XL -> if (square) k.r.lg else k.r.xl
}

/** Fill and ink of a variant, with the pressed overlay folded in. */
@Composable
private fun skin(variant: Variant, pressed: Boolean, on: Boolean): Pair<Color, Color> {
    val c = k.c
    return when (variant) {
        Variant.NEUTRAL -> (if (pressed) c.pressed.compositeOver(c.l1) else c.l1) to c.fg
        Variant.WARNING -> (if (pressed) c.pressed.compositeOver(c.l1) else c.l1) to c.warning.fg
        Variant.DANGER -> (if (pressed) c.pressed.compositeOver(c.l1) else c.l1) to c.danger.fg
        Variant.CONTRAST -> (if (pressed) c.bg.copy(alpha = 0.20f).compositeOver(c.accent) else c.accent) to c.accentFg
        Variant.OUTLINE -> (if (pressed) c.pressed else Color.Transparent) to c.fg
        Variant.GHOST -> (if (pressed || on) c.pressed else Color.Transparent) to c.fg
        Variant.GHOST_MUTED -> (if (pressed || on) c.pressed else Color.Transparent) to (if (on) c.fg else c.muted)
        Variant.GHOST_FAINT -> (if (pressed) c.pressed else Color.Transparent) to c.faint
    }
}

private fun Color.compositeOver(under: Color): Color {
    val a = alpha + under.alpha * (1 - alpha)
    if (a == 0f) return Color.Transparent
    fun ch(x: Float, y: Float) = (x * alpha + y * under.alpha * (1 - alpha)) / a
    return Color(ch(red, under.red), ch(green, under.green), ch(blue, under.blue), a)
}

@OptIn(ExperimentalFoundationApi::class)
private fun Modifier.press(source: MutableInteractionSource, enabled: Boolean, onClick: () -> Unit, onLong: (() -> Unit)?) =
    combinedClickable(interactionSource = source, indication = null, enabled = enabled, onLongClick = onLong, onClick = onClick)

@Composable
fun KButton(
    label: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    variant: Variant = Variant.NEUTRAL,
    size: Size = Size.SMALL,
    icon: ImageVector? = null,
    enabled: Boolean = true,
) {
    val source = remember { MutableInteractionSource() }
    val pressed by source.collectIsPressedAsState()
    val (fill, ink) = skin(variant, pressed, false)
    val shape = RoundedCornerShape(radiusFor(size))
    val text = when {
        size == Size.SMALL || size == Size.MINI -> if (variant == Variant.GHOST_MUTED) k.ty.small else k.ty.smallMedium
        else -> if (variant == Variant.GHOST_MUTED) k.ty.ui else k.ty.uiMedium
    }
    Row(
        modifier
            .alpha(if (enabled) 1f else if (variant == Variant.CONTRAST) 0.4f else 0.5f)
            .then(if (variant == Variant.NEUTRAL || variant == Variant.WARNING || variant == Variant.DANGER) Modifier.shadow(1.dp, shape, ambientColor = k.c.shadow, spotColor = k.c.shadow) else Modifier)
            .clip(shape)
            .background(if (variant == Variant.CONTRAST) Brush.verticalGradient(listOf(Color.White.copy(alpha = 0.20f).compositeOver(fill), fill)) else SolidColor(fill))
            .then(
                when (variant) {
                    Variant.OUTLINE -> Modifier.border(1.dp, k.c.border, shape)
                    Variant.NEUTRAL, Variant.WARNING, Variant.DANGER -> Modifier.border(0.5.dp, k.c.border, shape)
                    else -> Modifier
                },
            )
            .press(source, enabled, onClick, null)
            .height(size.h)
            .padding(horizontal = size.px),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(if (size == Size.MINI) 4.dp else 6.dp),
    ) {
        icon?.let { KIcon(it, ink, size.icon) }
        Text(label, style = text, color = ink, maxLines = 1)
    }
}

@Composable
fun KIconButton(
    icon: ImageVector,
    label: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    variant: Variant = Variant.GHOST_MUTED,
    size: Size = Size.REGULAR,
    on: Boolean = false,
    tint: Color? = null,
    enabled: Boolean = true,
    onLongClick: (() -> Unit)? = null,
) {
    val source = remember { MutableInteractionSource() }
    val pressed by source.collectIsPressedAsState()
    val (fill, ink) = if (on && variant == Variant.GHOST_MUTED) skin(Variant.NEUTRAL, pressed, false) else skin(variant, pressed, false)
    val shape = RoundedCornerShape(radiusFor(size, square = true))
    Box(
        modifier
            .alpha(if (enabled) 1f else 0.5f)
            .size(size.square)
            .clip(shape)
            .background(fill)
            .then(if (on && variant == Variant.GHOST_MUTED || variant == Variant.NEUTRAL) Modifier.border(0.5.dp, k.c.border, shape) else Modifier)
            .press(source, enabled, onClick, onLongClick),
        contentAlignment = Alignment.Center,
    ) { KIcon(icon, tint ?: ink, size.squareIcon, label = label) }
}

/** rune's `pill`: h 20, px 8, radius 10 whatever the corners. */
@Composable
fun Pill(label: String, fg: Color, bg: Color, modifier: Modifier = Modifier, lead: (@Composable () -> Unit)? = null) {
    Row(
        modifier.height(20.dp).clip(RoundedCornerShape(10.dp)).background(bg).padding(horizontal = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(5.dp),
    ) {
        lead?.invoke()
        Text(label, style = k.ty.textXsmallMedium, color = fg, maxLines = 1)
    }
}

/** A state disc; square with sharp corners. */
@Composable
fun Dot(color: Color, size: Dp, modifier: Modifier = Modifier) {
    Box(modifier.size(size).clip(if (k.r.sharp) RectangleShape else CircleShape).background(color))
}

@Composable
fun SectionTitle(text: String, modifier: Modifier = Modifier) {
    Text(text, style = k.ty.textXsmallMedium, color = k.c.faint, modifier = modifier, maxLines = 1)
}

/** The Java-style string hash rune uses to pick a tag colour (u32 wrapping). */
fun tagIndex(name: String, overrides: Map<String, Int> = emptyMap()): Int {
    overrides[name]?.let { return it }
    when (name) {
        "chart" -> return 0
        "constant" -> return 1
        "azure" -> return 3
        "infra" -> return 4
        "urgent" -> return 5
    }
    var h = 0L
    for (ch in name.lowercase()) h = (h * 31 + ch.code) and 0xffffffffL
    return (h % 6).toInt()
}

/** A tag in a sidebar row or the session header: `#name` on the hue at 14 %. */
@Composable
fun TagPill(name: String, overrides: Map<String, Int> = emptyMap(), fleet: Boolean = false, modifier: Modifier = Modifier) {
    val hue = k.c.tagHue(tagIndex(name, overrides))
    val shape = if (fleet) RoundedCornerShape(k.r.sm) else RoundedCornerShape(8.5.dp)
    Box(
        modifier.height(17.dp).clip(shape).background(hue.copy(alpha = if (fleet) 0.13f else 0.14f)).padding(horizontal = if (fleet) 6.dp else 7.dp),
        contentAlignment = Alignment.Center,
    ) { Text(if (fleet) "# $name" else "#$name", style = k.ty.tag, color = hue, maxLines = 1) }
}

/** rune-kit's TextInput: h 28, radius md, page fill, 1 border. */
@Composable
fun KTextInput(
    value: String,
    onValueChange: (String) -> Unit,
    placeholder: String,
    modifier: Modifier = Modifier,
    singleLine: Boolean = true,
    minHeight: Dp = 28.dp,
    style: TextStyle = k.ty.ui,
    onSubmit: (() -> Unit)? = null,
    leading: (@Composable () -> Unit)? = null,
) {
    val kb = LocalSoftwareKeyboardController.current
    val shape = RoundedCornerShape(k.r.md)
    BasicTextField(
        value = value,
        onValueChange = onValueChange,
        singleLine = singleLine,
        textStyle = style.copy(color = k.c.fg),
        cursorBrush = SolidColor(k.c.accent),
        keyboardOptions = KeyboardOptions.Default,
        keyboardActions = KeyboardActions(onDone = { onSubmit?.invoke(); if (onSubmit != null) kb?.hide() }, onSearch = { onSubmit?.invoke() }),
        modifier = modifier.heightIn(min = minHeight),
        decorationBox = { inner ->
            Row(
                Modifier.clip(shape).background(k.c.bg).border(1.dp, k.c.border, shape).heightIn(min = minHeight).padding(horizontal = 8.dp, vertical = 4.dp),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                leading?.invoke()
                Box(Modifier.weight(1f)) {
                    if (value.isEmpty()) Text(placeholder, style = style, color = k.c.faint, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    inner()
                }
            }
        },
    )
}

/** A rune-kit menu: radius 6 surface, items h 28 with optional description, icon and right text. */
@Composable
fun KMenu(expanded: Boolean, onDismiss: () -> Unit, minWidth: Dp = 200.dp, offset: DpOffset = DpOffset(0.dp, 6.dp), content: @Composable () -> Unit) {
    DropdownMenu(
        expanded = expanded,
        onDismissRequest = onDismiss,
        offset = offset,
        shape = RoundedCornerShape(6.dp),
        containerColor = k.c.surface,
        border = androidx.compose.foundation.BorderStroke(0.5.dp, k.c.border),
        shadowElevation = 6.dp,
        modifier = Modifier.widthIn(min = minWidth).padding(horizontal = 2.dp),
    ) { content() }
}

@Composable
fun KMenuItem(
    label: String,
    onClick: () -> Unit,
    icon: ImageVector? = null,
    description: String? = null,
    trailing: String? = null,
    checked: Boolean? = null,
    enabled: Boolean = true,
    danger: Boolean = false,
) {
    DropdownMenuItem(
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(label, style = k.ty.uiCompact, color = if (danger) k.c.danger.fg else k.c.fg, maxLines = 1)
                description?.let { Text(it, style = k.ty.small, color = k.c.faint) }
            }
        },
        onClick = onClick,
        enabled = enabled,
        leadingIcon = icon?.let { { KIcon(it, if (danger) k.c.danger.fg else k.c.fg, 14.dp) } },
        trailingIcon = when {
            checked != null -> ({ Box(Modifier.size(16.dp), contentAlignment = Alignment.Center) { if (checked) KIcon(CheckGlyph, k.c.fg, 14.dp) } })
            trailing != null -> ({ Text(trailing, style = k.ty.smallMedium, color = k.c.faint) })
            else -> null
        },
        colors = MenuDefaults.itemColors(),
        contentPadding = PaddingValues(start = 12.dp, end = 6.dp, top = if (description != null) 6.dp else 0.dp, bottom = if (description != null) 6.dp else 0.dp),
        modifier = Modifier.defaultMinSize(minHeight = 28.dp).heightIn(min = 28.dp).clip(RoundedCornerShape(4.dp)),
    )
}

@Composable
fun KMenuGroup(label: String) {
    Box(Modifier.height(28.dp).padding(horizontal = 12.dp), contentAlignment = Alignment.CenterStart) {
        Text(label, style = k.ty.smallMedium, color = k.c.faint)
    }
}

@Composable
fun KMenuSeparator() = HorizontalDivider(Modifier.padding(vertical = 2.dp), thickness = 1.dp, color = k.c.border)

/** rune's "Soft Radar": a 5×5 dot grid whose lit head sweeps each square ring every 1.8 s. */
@Composable
fun Spinner(size: Dp = 18.dp, color: Color = k.c.fg) {
    val t = rememberInfiniteTransition(label = "radar")
    val phase by t.animateFloat(0f, 1f, infiniteRepeatable(tween(1800, easing = LinearEasing), RepeatMode.Restart), label = "phase")
    val fade = floatArrayOf(1f, .987f, .934f, .812f, .599f, .384f, .238f, .143f, .081f, .041f, .017f, .004f, 0f)
    Canvas(Modifier.size(size)) {
        val pitch = this.size.minDimension / 16f * 3f
        val origin = (this.size.minDimension - pitch * 4) / 2
        val r = this.size.minDimension / 16f
        for (row in 0 until 5) for (col in 0 until 5) {
            val ring = maxOf(kotlin.math.abs(row - 2), kotlin.math.abs(col - 2))
            val alpha = if (ring == 0) 0.64f else {
                // Position of this dot along its ring, clockwise from the top-left corner.
                val side = ring * 2
                val x = col - 2 + ring
                val y = row - 2 + ring
                val pos = when {
                    y == 0 -> x
                    x == side -> side + y
                    y == side -> 3 * side - x
                    else -> 4 * side - y
                }.toFloat() / (4 * side)
                val since = ((phase - pos) % 1f + 1f) % 1f
                val idx = (since / 0.04f).toInt()
                if (idx < fade.size) maxOf(0.2f, fade[idx]) else 0.2f
            }
            drawCircle(color.copy(alpha = alpha), r, Offset(origin + col * pitch, origin + row * pitch))
        }
    }
}

/** A short-lived confirmation in the top bar: "✓ …" in success, "✗ …" in danger. */
@Composable
fun FlashToast(message: String, modifier: Modifier = Modifier) {
    val tone = if (message.startsWith("✗")) k.c.danger else k.c.success
    val shape = RoundedCornerShape(k.r.md)
    Box(
        modifier.height(26.dp).widthIn(max = 420.dp).clip(shape).background(tone.soft).border(1.dp, tone.border, shape).padding(horizontal = 10.dp),
        contentAlignment = Alignment.CenterStart,
    ) { Text(message, style = k.ty.textSmallMedium, color = tone.ink, maxLines = 1, overflow = TextOverflow.Ellipsis) }
}

/** A rune-kit surface: fill, 1 border, radius. */
fun Modifier.panel(fill: Color, border: Color, radius: Dp, width: Dp = 1.dp) =
    clip(RoundedCornerShape(radius)).background(fill).border(width, border, RoundedCornerShape(radius))

/** Row helper with the hover-less press overlay rune uses on rows and tabs. */
@OptIn(ExperimentalFoundationApi::class)
@Composable
fun Pressable(
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    onLongClick: (() -> Unit)? = null,
    fill: Color = Color.Transparent,
    radius: Dp = k.r.md,
    content: @Composable RowScope.() -> Unit,
) {
    val source = remember { MutableInteractionSource() }
    val pressed by source.collectIsPressedAsState()
    Row(
        modifier.clip(RoundedCornerShape(radius)).background(if (pressed) k.c.pressed.compositeOver(fill) else fill)
            .combinedClickable(interactionSource = source, indication = null, onClick = onClick, onLongClick = onLongClick),
        verticalAlignment = Alignment.CenterVertically,
        content = content,
    )
}

/** Width helper so callers need not import fillMaxWidth for a trivial row. */
fun Modifier.full() = fillMaxWidth()

/** Lucide `check`, which rune's icon set lacks. */
val CheckGlyph by lazy { lucide("check", "M20 6 9 17l-5-5") }
