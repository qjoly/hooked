package dev.qjoly.hooked

import android.Manifest
import android.content.Intent
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.viewModels
import androidx.lifecycle.lifecycleScope
import dev.qjoly.hooked.state.AppModel
import dev.qjoly.hooked.ui.HookedApp
import kotlinx.coroutines.launch

class MainActivity : ComponentActivity() {
    companion object {
        const val ACTION_NEW_SESSION = "dev.qjoly.hooked.NEW_SESSION"
    }

    private val app: AppModel by viewModels()
    private val notifyPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) { WatchService.sync(this) }

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge()
        super.onCreate(savedInstanceState)
        if (savedInstanceState == null) handle(intent)
        setContent { HookedApp(app, ::askNotifications) }
        if (AppPrefs.notify(this)) askNotifications()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handle(intent)
    }

    override fun onStart() {
        super.onStart()
        WatchService.appVisible = true
        app.start()
    }

    override fun onResume() {
        super.onResume()
        Notify.cancelSessions(this)
        WatchService.sync(this)
    }

    override fun onStop() {
        WatchService.appVisible = false
        app.stop()
        super.onStop()
    }

    private fun askNotifications() {
        if (Build.VERSION.SDK_INT >= 33 && !Notify.allowed(this)) notifyPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
        else WatchService.sync(this)
    }

    /** A notification opens its session, a pairing link switches server, the launcher shortcut starts a session. */
    private fun handle(intent: Intent?) {
        intent ?: return
        intent.getStringExtra(Notify.EXTRA_SESSION)?.let(app::open)
        if (intent.action == ACTION_NEW_SESSION) app.showNew = true
        val link = intent.dataString?.let(ServerConfig::fromLink) ?: return
        lifecycleScope.launch { app.pair(link)?.let { app.message = "Pairing with ${link.base} failed: $it" } }
    }
}
