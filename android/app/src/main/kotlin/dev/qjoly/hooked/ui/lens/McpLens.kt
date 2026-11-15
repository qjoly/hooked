package dev.qjoly.hooked.ui.lens

import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import dev.qjoly.hooked.state.AppModel
import dev.qjoly.hooked.state.SessionModel
import dev.qjoly.hooked.ui.pages.Placeholder

/** rune's MCP lens. */
@Composable
fun McpLens(app: AppModel, model: SessionModel, modifier: Modifier = Modifier) = Placeholder("MCP")
