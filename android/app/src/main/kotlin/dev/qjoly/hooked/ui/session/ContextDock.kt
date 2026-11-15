package dev.qjoly.hooked.ui.session

import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import dev.qjoly.hooked.state.AppModel
import dev.qjoly.hooked.state.SessionModel
import dev.qjoly.hooked.ui.pages.Placeholder

/** rune's right-hand "Session context" column (`view/dock.rs`). */
@Composable
fun ContextDock(app: AppModel, model: SessionModel, modifier: Modifier = Modifier) = Placeholder("Session context")
