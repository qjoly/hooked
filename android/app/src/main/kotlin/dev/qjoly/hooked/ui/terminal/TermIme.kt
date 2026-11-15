package dev.qjoly.hooked.ui.terminal

import android.text.InputType
import android.view.KeyEvent
import android.view.View
import android.view.inputmethod.BaseInputConnection
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputConnection
import android.view.inputmethod.InputMethodManager
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusEventModifierNode
import androidx.compose.ui.focus.FocusState
import androidx.compose.ui.node.ModifierNodeElement
import androidx.compose.ui.platform.PlatformTextInputMethodRequest
import androidx.compose.ui.platform.PlatformTextInputModifierNode
import androidx.compose.ui.platform.establishTextInputSession
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch

/**
 * The soft keyboard's line into a terminal, as Termux's view opens one: a password-style field so
 * keyboards neither predict nor autocorrect, whose committed text goes straight to the shell. Keys
 * the keyboard sends as events (Backspace, Enter, arrows) reach the screen's key handler instead.
 */
internal class TermIme {
    var deck: TermDeck? = null
    private var view: View? = null
    private var pending = false

    val active get() = view != null

    fun show() {
        val v = view
        if (v == null) {
            pending = true
            return
        }
        imm(v).showSoftInput(v, 0)
    }

    fun hide() {
        pending = false
        view?.let { imm(it).hideSoftInputFromWindow(it.windowToken, 0) }
    }

    fun attached(v: View) {
        view = v
        if (pending) {
            pending = false
            // After the input method restarted on this connection.
            v.post { imm(v).showSoftInput(v, 0) }
        }
    }

    fun detached() {
        view = null
        deck?.preedit = ""
    }

    private fun imm(v: View) = v.context.getSystemService(InputMethodManager::class.java)

    fun connection(v: View, info: EditorInfo): InputConnection {
        info.inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS
        info.imeOptions = EditorInfo.IME_FLAG_NO_FULLSCREEN or EditorInfo.IME_FLAG_NO_EXTRACT_UI or EditorInfo.IME_ACTION_NONE
        info.initialSelStart = 0
        info.initialSelEnd = 0
        return object : BaseInputConnection(v, true) {
            override fun commitText(text: CharSequence?, newCursorPosition: Int): Boolean {
                super.commitText(text, newCursorPosition)
                flush()
                return true
            }

            override fun setComposingText(text: CharSequence?, newCursorPosition: Int): Boolean {
                super.setComposingText(text, newCursorPosition)
                deck?.preedit = text?.toString().orEmpty()
                return true
            }

            override fun finishComposingText(): Boolean {
                super.finishComposingText()
                flush()
                return true
            }

            override fun deleteSurroundingText(beforeLength: Int, afterLength: Int): Boolean {
                if (!editable.isNullOrEmpty()) {
                    val done = super.deleteSurroundingText(beforeLength, afterLength)
                    deck?.preedit = editable?.toString().orEmpty()
                    return done
                }
                // Committed text never stays in the field, so a delete is a Backspace (some keyboards never send the key).
                repeat(beforeLength.coerceAtMost(64)) { deck?.typeKey(KeyEvent.KEYCODE_DEL) }
                return true
            }

            override fun performEditorAction(editorAction: Int): Boolean {
                deck?.typeKey(KeyEvent.KEYCODE_ENTER)
                return true
            }

            private fun flush() {
                val e = editable ?: return
                val s = e.toString()
                e.clear()
                deck?.preedit = ""
                if (s.isNotEmpty()) deck?.typeText(s)
            }
        }
    }
}

private class TermImeElement(val ime: TermIme) : ModifierNodeElement<TermImeNode>() {
    override fun create() = TermImeNode(ime)

    override fun update(node: TermImeNode) {
        node.ime = ime
    }

    override fun equals(other: Any?) = other is TermImeElement && other.ime === ime

    override fun hashCode() = System.identityHashCode(ime)
}

/** Holds an input session open while the terminal has focus. Place it before the focus target. */
private class TermImeNode(var ime: TermIme) : Modifier.Node(), PlatformTextInputModifierNode, FocusEventModifierNode {
    private var session: Job? = null

    override fun onFocusEvent(focusState: FocusState) {
        if (!isAttached) return
        if (focusState.isFocused) {
            if (session != null) return
            session = coroutineScope.launch {
                establishTextInputSession {
                    ime.attached(view)
                    try {
                        startInputMethod(object : PlatformTextInputMethodRequest {
                            override fun createInputConnection(outAttributes: EditorInfo) = ime.connection(view, outAttributes)
                        })
                    } finally {
                        ime.detached()
                    }
                }
            }
        } else {
            session?.cancel()
            session = null
        }
    }

    override fun onDetach() {
        if (session != null) ime.hide()
        session?.cancel()
        session = null
    }
}

internal fun Modifier.termIme(ime: TermIme): Modifier = this then TermImeElement(ime)
