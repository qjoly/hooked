package dev.qjoly.hooked.ui.lens

import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import dev.qjoly.hooked.state.AppModel
import dev.qjoly.hooked.state.SessionModel
import dev.qjoly.hooked.ui.pages.Placeholder

/** rune's Review lens. */
@Composable
fun ReviewLens(app: AppModel, model: SessionModel, modifier: Modifier = Modifier) = Placeholder("Review")
