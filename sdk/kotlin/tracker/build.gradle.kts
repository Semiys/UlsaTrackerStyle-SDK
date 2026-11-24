import org.gradle.jvm.tasks.Jar
import org.gradle.plugins.signing.SigningExtension
import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    kotlin("multiplatform")
    kotlin("plugin.serialization")
    id("com.android.kotlin.multiplatform.library")
    id("com.vanniktech.maven.publish") version "0.37.0"
}

group = "io.github.semiys.ulsatracker"
version = "0.2.0"

val centralRelease = providers.gradleProperty("centralRelease").orNull == "true"

mavenPublishing {
    if (centralRelease) {
        publishToMavenCentral(automaticRelease = false)
        signAllPublications()
    }
    pom {
        name.set("UlsaTracker Kotlin SDK")
        description.set("Explicit product analytics events for Android and JVM applications.")
        url.set("https://github.com/Semiys/UlsaTrackerStyle-SDK")
        licenses {
            license {
                name.set("MIT License")
                url.set("https://opensource.org/license/mit")
                distribution.set("repo")
            }
        }
        developers {
            developer {
                id.set("semiys")
                name.set("Semiys")
                url.set("https://github.com/Semiys")
            }
        }
        scm {
            url.set("https://github.com/Semiys/UlsaTrackerStyle-SDK")
            connection.set("scm:git:https://github.com/Semiys/UlsaTrackerStyle-SDK.git")
            developerConnection.set("scm:git:ssh://git@github.com/Semiys/UlsaTrackerStyle-SDK.git")
        }
    }
}

if (centralRelease) {
    extensions.configure<SigningExtension> { useGpgCmd() }
}

kotlin {
    android {
        namespace = "io.github.semiys.ulsatracker"
        compileSdk = 37
        minSdk = 26
        compilerOptions { jvmTarget.set(JvmTarget.JVM_11) }
    }
    jvm { compilerOptions { jvmTarget.set(JvmTarget.JVM_11) } }
    sourceSets {
        commonMain.dependencies {
            api("org.jetbrains.kotlinx:kotlinx-coroutines-core:1.11.0")
            implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.11.0")
            implementation("io.ktor:ktor-client-core:3.6.0")
        }
        commonTest.dependencies {
            implementation(kotlin("test"))
            implementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.11.0")
        }
        val jvmSharedMain by creating {
            dependsOn(commonMain.get())
            dependencies { implementation("io.ktor:ktor-client-okhttp:3.6.0") }
        }
        androidMain.get().dependsOn(jvmSharedMain)
        jvmMain.get().dependsOn(jvmSharedMain)
        jvmTest.get().dependsOn(commonTest.get())
        jvmTest.dependencies {
            implementation("io.ktor:ktor-client-mock:3.6.0")
            implementation(kotlin("test-junit"))
        }
    }
}

tasks.withType<Test>().configureEach {
    // Passed explicitly by the local end-to-end check; keys stay out of test reports.
    listOf("ULSA_TEST_ENDPOINT", "ULSA_TEST_INGEST_KEY", "ULSA_TEST_READ_KEY").forEach { name ->
        providers.environmentVariable(name).orNull?.let { environment(name, it) }
    }
}

tasks.withType<Jar>().configureEach {
    if (name == "allMetadataJar" || name.endsWith("sourcesJar", ignoreCase = true)) {
        from(layout.projectDirectory.file("src/commonMain/resources/META-INF/LICENSE-ulsa-tracker")) {
            into("META-INF")
        }
    }
}
