pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
        // Termux's terminal emulator only ships there.
        maven("https://jitpack.io") {
            content { includeGroup("com.github.termux.termux-app") }
        }
    }
}

rootProject.name = "hooked"
include(":app")
