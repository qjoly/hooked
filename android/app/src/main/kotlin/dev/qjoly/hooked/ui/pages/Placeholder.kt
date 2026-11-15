package dev.qjoly.hooked.ui.pages

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import dev.qjoly.hooked.ui.kit.k

/** A page that is not built yet. */
@Composable
fun Placeholder(title: String) {
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { Text("$title: coming soon", style = k.ty.body, color = k.c.muted) }
}
