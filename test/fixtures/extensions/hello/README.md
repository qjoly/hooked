# hello (test fixture)

The smallest extension with no page. It proves the feature-only path of the contract: declarative
settings, a `turn:end` listener that counts turns, a session menu action that answers a `flash`, the
tool `hello_count`, and a lifecycle whose timer `stop()` clears. `test/extensions.test.mjs` installs
it from a local git repo, updates it and removes it in a running registry.
