package dev.qjoly.hooked.ui

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.KeyboardReturn
import androidx.compose.material.icons.automirrored.rounded.Send
import androidx.compose.material.icons.outlined.AddPhotoAlternate
import androidx.compose.material.icons.outlined.ErrorOutline
import androidx.compose.material.icons.rounded.Close
import androidx.compose.material.icons.rounded.Stop
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.FilledIconButton
import androidx.compose.material3.FilledTonalIconButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.IconButtonDefaults
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.SuggestionChip
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.isShiftPressed
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.qjoly.hooked.data.SessionState
import dev.qjoly.hooked.state.SessionModel
import kotlinx.coroutines.launch

@Composable
fun Composer(model: SessionModel, answering: Boolean, followup: String?) {
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    var text by rememberSaveable(model.id) { mutableStateOf("") }
    val pick = rememberLauncherForActivityResult(ActivityResultContracts.PickMultipleVisualMedia(4)) { uris ->
        uris.forEach { model.attach(ctx, it) }
    }
    val hasContent = text.isNotBlank() || model.attachments.any { it.path != null }
    fun send() {
        if (!hasContent || model.sending) return
        scope.launch { if (model.send(text)) text = "" }
    }

    Column(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        if (model.attachments.isNotEmpty()) {
            LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                items(model.attachments, key = { it.key }) { a ->
                    Box(Modifier.size(64.dp)) {
                        Image(a.thumbnail, null, Modifier.size(64.dp).clip(RoundedCornerShape(12.dp)), contentScale = ContentScale.Crop)
                        when {
                            a.failed -> Icon(Icons.Outlined.ErrorOutline, "Upload failed", Modifier.align(Alignment.Center), tint = stateStyle(SessionState.ATTENTION).hue)
                            a.path == null -> CircularProgressIndicator(Modifier.size(22.dp).align(Alignment.Center), strokeWidth = 2.dp)
                        }
                        Box(
                            Modifier.align(Alignment.TopEnd).padding(2.dp).size(22.dp).background(hooked.code.copy(alpha = 0.7f), CircleShape),
                            contentAlignment = Alignment.Center,
                        ) {
                            IconButton({ model.attachments.removeAll { it.key == a.key } }, Modifier.size(22.dp)) {
                                Icon(Icons.Rounded.Close, "Remove image", Modifier.size(14.dp), tint = hooked.codeFg)
                            }
                        }
                    }
                }
            }
        }
        if (followup != null && text.isEmpty() && !answering) {
            SuggestionChip(
                onClick = { text = followup },
                label = { Text(followup, maxLines = 1, overflow = TextOverflow.Ellipsis) },
                icon = { Icon(Icons.AutoMirrored.Outlined.KeyboardReturn, null, Modifier.size(16.dp)) },
            )
        }
        Row(verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            IconButton(
                { pick.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)) },
                Modifier.padding(bottom = 4.dp),
            ) {
                Icon(Icons.Outlined.AddPhotoAlternate, "Attach images", tint = hooked.muted)
            }
            OutlinedTextField(
                value = text,
                onValueChange = { text = it },
                placeholder = { Text(if (answering) "Type your own answer…" else "Message Claude") },
                maxLines = 8,
                shape = RoundedCornerShape(24.dp),
                colors = OutlinedTextFieldDefaults.colors(
                    focusedContainerColor = hooked.card, unfocusedContainerColor = hooked.card,
                    unfocusedBorderColor = hooked.line, focusedBorderColor = hooked.accent,
                ),
                textStyle = androidx.compose.material3.MaterialTheme.typography.bodyLarge.copy(fontSize = 15.sp),
                // A keyboard cover behaves like the web composer: Enter sends, Shift+Enter breaks the line.
                modifier = Modifier.weight(1f).onPreviewKeyEvent { e ->
                    if (e.key == Key.Enter && !e.isShiftPressed) {
                        if (e.type == KeyEventType.KeyDown) send()
                        true
                    } else {
                        false
                    }
                },
            )
            if (model.isBusy) {
                FilledTonalIconButton(
                    { model.interrupt() },
                    Modifier.padding(bottom = 4.dp).size(48.dp),
                    colors = IconButtonDefaults.filledTonalIconButtonColors(contentColor = stateStyle(SessionState.ATTENTION).ink),
                ) { Icon(Icons.Rounded.Stop, "Interrupt") }
            }
            FilledIconButton(::send, Modifier.padding(bottom = 4.dp).size(48.dp), enabled = hasContent && !model.sending) {
                if (model.sending) CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
                else Icon(Icons.AutoMirrored.Rounded.Send, "Send")
            }
        }
    }
}
