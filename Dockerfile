# syntax=docker/dockerfile:1.7
#
# Java Test Executor — ONE image, two stages.
#
# This was a two-image chain: Dockerfile.base built `java-test-executor-base` into the estate's
# private registry and the app pinned it by digest. For the public repository the chain is folded
# into a single build — `toolchain` is the old base (Temurin 21 + node for the service), `app` is
# the service. One artefact to publish, nothing to pin, no private registry anywhere.
FROM docker.io/library/node:26-alpine AS nodebase

FROM docker.io/library/eclipse-temurin:21-jdk-alpine AS toolchain

COPY --from=nodebase /usr/local/bin/node /usr/local/bin/node
COPY --from=nodebase /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -sf /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
 && ln -sf /usr/local/lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx

# libatomic: node 26's amd64 binary needs libatomic.so.1, which the temurin alpine
# base does not ship. Without it the binary fails at exec with
#   Error relocating /usr/local/bin/node: __atomic_compare_exchange: symbol not found
# (measured 2026-11-06, amd64 build of this file; node 24 did not need it).
RUN apk add --no-cache maven curl bash libatomic

# ⚠️ CORRECTION (2026-08-18): the premise of the commit that added this block
# was WRONG, and the correction is kept here rather than quietly deleted.
#
# I claimed production shipped openjdk 25 on PATH ahead of Temurin 21, because
# `apk add maven` pulls openjdk25-jdk as a dependency. Re-measured against the
# actual production image:
#
#   image PATH declares          : /opt/java/openjdk/bin FIRST
#   sh -c  (what exec() uses)    : /opt/java/openjdk/bin/java -> 21.0.11
#   direct exec, no shell        :                               21.0.11
#   sh -lc (a LOGIN shell)       : /usr/bin/java              -> 25.0.4
#
# Only the LOGIN shell sees 25, because Alpine's /etc/profile re-exports PATH
# over the image ENV. The service runs everything through `exec()` = /bin/sh -c,
# non-login, and never invokes a bare `java` anyway (it runs mvn/gradle/javac).
# So there was no live defect: I manufactured one by probing with `sh -lc`.
#
# What that means for the two lines below:
#   * the `ENV PATH` prepend is a NO-OP — /opt/java/openjdk/bin was already
#     first, and adding it again merely duplicates the entry. It does NOT fix
#     the login-shell case either, because /etc/profile runs after ENV.
#   * the assert therefore cannot catch the drift it was written for: the
#     PRE-fix base passes it identically. The "mutation-checked" evidence came
#     from an artificial PATH reorder, not from a reachable failure.
#
# The assert is KEPT, re-scoped honestly: it is a forward invariant — "this base
# ships a Java 21 toolchain and Maven runs on it" — not a fix for a present bug.
# That is still worth failing the build over, because a future base bump to a
# different JDK would change compilation semantics for every /execute. The
# no-op ENV line is removed rather than left to imply it does something.
# FOLLOW-UP, deliberately not done here: those openjdk25 packages are ~180 MB of
# JDK that nothing uses. Dropping them means installing Maven from the Apache
# binary tarball instead of apk (Maven is a Java app and needs no JDK of its
# own), which is a bigger change than this split and belongs in its own PR with
# its own proof. Recorded rather than bundled.

# ── Offline Maven repository ─────────────────────────────────────────────────
# The runtime namespace has ZERO internet egress (NetworkPolicy default-restrict
# allows own-ns + kube-system:53 + the cluster CIDRs, nothing else), so every
# /execute died resolving junit/surefire/jacoco from Maven Central. /root/.m2 was
# 372K in the shipped image — nothing was ever baked, which is why java had never
# worked.
#
# /opt/m2 stays a read-only image layer: measured offline as uid 65532 with a
# read-only rootfs, `mvn test`, `mvn jacoco:report`, `mvn checkstyle:check`,
# `mvn pmd:check` and `mvn spotbugs:check` are all BUILD SUCCESS against it.
# Maven does not write to the local repository for a test run that installs
# nothing, so no copy-to-writable step is needed.
COPY src/pom-template.js /opt/bake-src/pom-template.js
COPY scripts/print-pom.js /opt/bake-src/print-pom.js
RUN mkdir -p /opt/bake/src/main/java /opt/bake/src/test/java \
 && node -e "process.stdout.write(require('/opt/bake-src/pom-template').MAVEN_POM_TEMPLATE)" > /opt/bake/pom.xml \
 && grep -q '<artifactId>junit-jupiter</artifactId>' /opt/bake/pom.xml \
 && printf 'public class Bake { public static int add(int a, int b) { return a + b; } }\n' > /opt/bake/src/main/java/Bake.java \
 && printf 'import org.junit.jupiter.api.Test;\nimport static org.junit.jupiter.api.Assertions.*;\npublic class BakeTest { @Test void t() { assertEquals(3, Bake.add(1, 2)); } }\n' > /opt/bake/src/test/java/BakeTest.java \
 && cd /opt/bake \
 # `mvn test` warms junit + surefire + jacoco (prepare-agent and report are bound
 # to the test phase by the template). The second run warms the three analysis
 # plugins the service invokes by default. It uses the REPORT goals, not the
 # `check` goals: violations must never fail the bake — only a missing artifact
 # should — and `-D*.failOnViolation=false` does not override a value the pom
 # template sets in <configuration>. Measured 2026-11-14: with `check`, a newer
 # plugin resolved at build time failed the image on JavadocPackage/FinalParameters
 # in the throwaway bake source. The report goals download the same artifacts.
 && mvn -B -q -Dmaven.repo.local=/opt/m2 test \
 && mvn -B -q -Dmaven.repo.local=/opt/m2 \
        checkstyle:checkstyle pmd:pmd spotbugs:spotbugs \
 && rm -rf /opt/bake /opt/bake-src \
 # Readable + traversable by any uid: the Deployment runs this container non-root,
 # and a repository it cannot read is a repository that does not exist.
 && chmod -R a+rX /opt/m2 \
 && test -d /opt/m2/org/junit/jupiter || { echo "FATAL: /opt/m2 has no junit — the image would ship an executor that cannot resolve offline" >&2; exit 1; }

# -o makes a missing artifact fail immediately and legibly instead of hanging on
# a blocked connection; MAVEN_ARGS is honoured by the mvn wrapper, so the service
# needs no code change to pick these up.
ENV MAVEN_ARGS="-o -Dmaven.repo.local=/opt/m2"

# ── Application ──────────────────────────────────────────────────────────────
FROM toolchain AS app


WORKDIR /app

COPY src/package.json src/package-lock.json ./
RUN npm ci && npm cache clean --force

# BOTH local modules. java_test_service.js requires ./pom-template — the copy at
# /opt/bake-src above is deleted with the bake scratch dir, so shipping only
# the service file produced an image that CrashLooped on boot with
#   Error: Cannot find module './pom-template'
# dockerfile-copies-modules.test.js now fails if a new local require is added
# without a COPY.
COPY src/java_test_service.js src/pom-template.js src/common.js ./

RUN mkdir -p /app/test_workspace /app/reports

EXPOSE 8088

HEALTHCHECK --interval=30s --timeout=10s --retries=3 \
    CMD curl -f http://localhost:8088/health || exit 1

CMD ["node", "java_test_service.js"]
