package dev.qjoly.hooked.ui.terminal

import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import dev.qjoly.hooked.state.AppModel
import dev.qjoly.hooked.ui.pages.Placeholder

/** rune's Terminal lens: the session's shells over hooked's PTYs. `project` is the shell's working directory. */
@Composable
fun TerminalPanel(app: AppModel, sessionId: String, project: String?, modifier: Modifier = Modifier) = Placeholder("Terminal")
