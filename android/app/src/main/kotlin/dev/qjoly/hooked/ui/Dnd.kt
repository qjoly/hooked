package dev.qjoly.hooked.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectDragGesturesAfterLongPress
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.LayoutCoordinates
import androidx.compose.ui.layout.boundsInRoot
import androidx.compose.ui.layout.layout
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.positionInRoot
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import dev.qjoly.hooked.state.AppModel
import dev.qjoly.hooked.state.Drop
import dev.qjoly.hooked.state.DropBox
import dev.qjoly.hooked.state.dropAllowed
import dev.qjoly.hooked.state.dropHot
import dev.qjoly.hooked.state.groupLabel
import dev.qjoly.hooked.state.hitDrop
import dev.qjoly.hooked.state.leadOf
import dev.qjoly.hooked.ui.kit.k
import kotlin.math.roundToInt

/** The drag in progress, shared by the sidebar and the Deck: drop boxes live in root coordinates. */
@Stable
object Dnd {
    internal val boxes = HashMap<String, DropBox>()
    var id by mutableStateOf<String?>(null)
        private set
    var label by mutableStateOf("")
        private set
    var at by mutableStateOf(Offset.Zero)
        private set
    var over by mutableStateOf<Drop?>(null)
        private set

    fun hot(key: String) = id != null && dropHot(key, over)

    internal fun move(app: AppModel, from: String, point: Offset) {
        if (id == null) {
            id = from
            label = app.session(from)?.let(app::title).orEmpty()
        }
        at = point
        over = hitDrop(boxes, point.x, point.y, from)?.takeIf { dropAllowed(from, it, app.meta) }
    }

    internal fun drop(app: AppModel) {
        val from = id ?: return
        val target = over
        cancel()
        when (target) {
            is Drop.Session -> app.groupOp("join", from, target = leadOf(target.id, app.meta))
            Drop.Detach -> app.groupOp("leave", from)
            null -> {}
        }
    }

    internal fun cancel() {
        id = null
        over = null
    }
}

/** A drop target under `key`, tinted with the accent while a drag hovers it. */
@Composable
fun Modifier.dropTarget(key: String, radius: Dp = k.r.md): Modifier {
    DisposableEffect(key) { onDispose { Dnd.boxes.remove(key) } }
    val accent = k.c.accent
    val shape = RoundedCornerShape(radius)
    return onGloballyPositioned { c ->
        val b = c.boundsInRoot()
        Dnd.boxes[key] = DropBox(b.left, b.top, b.width, b.height)
    }.then(if (Dnd.hot(key)) Modifier.clip(shape).background(accent.copy(alpha = 0.12f)).border(1.dp, accent, shape) else Modifier)
}

/**
 * Long press then move drags the session; long press then release opens its menu. Put it inside the
 * click handler so it sees the release first and keeps a long press from also counting as a tap.
 */
@Composable
fun Modifier.sessionDrag(app: AppModel, id: String, onMenu: () -> Unit): Modifier {
    val haptic = LocalHapticFeedback.current
    val coords = remember { arrayOfNulls<LayoutCoordinates>(1) }
    val menu by rememberUpdatedState(onMenu)
    val model by rememberUpdatedState(app)
    return onGloballyPositioned { coords[0] = it }.pointerInput(id) {
        var travel = Offset.Zero
        detectDragGesturesAfterLongPress(
            onDragStart = {
                travel = Offset.Zero
                haptic.performHapticFeedback(HapticFeedbackType.LongPress)
            },
            onDrag = { change, delta ->
                change.consume()
                travel += delta
                if (Dnd.id == null && travel.getDistance() < viewConfiguration.touchSlop) return@detectDragGesturesAfterLongPress
                val c = coords[0]?.takeIf { it.isAttached } ?: return@detectDragGesturesAfterLongPress
                Dnd.move(model, id, c.localToRoot(change.position))
            },
            onDragEnd = { if (Dnd.id == null) menu() else Dnd.drop(model) },
            onDragCancel = { Dnd.cancel() },
        )
    }
}

/** The kit's Pressable with a session drag inside its click handler. */
@Composable
fun SessionPress(
    app: AppModel,
    id: String,
    onClick: () -> Unit,
    onMenu: () -> Unit,
    modifier: Modifier = Modifier,
    fill: Color = Color.Transparent,
    radius: Dp = k.r.md,
    content: @Composable RowScope.() -> Unit,
) {
    val source = remember { MutableInteractionSource() }
    val pressed by source.collectIsPressedAsState()
    Row(
        modifier.clip(RoundedCornerShape(radius)).background(fill).background(if (pressed) k.c.pressed else Color.Transparent)
            .clickable(source, indication = null, onClick = onClick)
            .sessionDrag(app, id, onMenu),
        verticalAlignment = Alignment.CenterVertically,
        content = content,
    )
}

/** rune's drag ghost: the session and what dropping would do, above and right of the finger. */
@Composable
fun DragGhost(app: AppModel) {
    var origin by remember { mutableStateOf(Offset.Zero) }
    Box(Modifier.fillMaxSize().onGloballyPositioned { origin = it.positionInRoot() }) {
        if (Dnd.id == null) return@Box
        val c = k.c
        val over = Dnd.over
        val hint = when (over) {
            is Drop.Session -> "Group with ${app.session(leadOf(over.id, app.meta))?.let { groupLabel(it, app.meta, app.prefs.names) }.orEmpty()}"
            Drop.Detach -> "Take out of its group"
            null -> "Drop on a session to group them"
        }
        val shape = RoundedCornerShape(k.r.md)
        Column(
            Modifier
                .layout { m, cs ->
                    val p = m.measure(cs.copy(minWidth = 0, minHeight = 0))
                    layout(p.width, p.height) {
                        val x = (Dnd.at.x - origin.x + 14.dp.toPx()).coerceIn(0f, (cs.maxWidth - p.width).toFloat().coerceAtLeast(0f))
                        val y = (Dnd.at.y - origin.y - p.height - 16.dp.toPx()).coerceAtLeast(0f)
                        p.place(x.roundToInt(), y.roundToInt())
                    }
                }
                .widthIn(max = 320.dp)
                .shadow(16.dp, shape, ambientColor = c.shadow, spotColor = c.shadow)
                .clip(shape).background(c.surface).border(1.dp, if (over != null) c.accent else c.border2, shape)
                .padding(horizontal = 10.dp, vertical = 6.dp),
            verticalArrangement = Arrangement.spacedBy(2.dp),
        ) {
            Text(Dnd.label, style = k.ty.textSmallMedium, color = c.fg, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(hint, style = k.ty.textXsmall, color = if (over != null) c.accent else c.faint, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
    }
}
