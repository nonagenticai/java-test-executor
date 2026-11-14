# java-test-executor

[![CI](https://github.com/nonagenticai/java-test-executor/actions/workflows/ci.yml/badge.svg)](https://github.com/nonagenticai/java-test-executor/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

Executes Java unit tests inside an isolated container on behalf of the `coding-testing` orchestrator. A caller sends Java source files and test files over HTTP; this service scaffolds a Maven or Gradle project, compiles the code, runs the tests, collects JaCoCo coverage, runs static analysis (Checkstyle/PMD/SpotBugs), and returns structured results. It exists so that the rest of the code-graph-helper system never needs a JDK or build toolchain installed locally.

| | |
|---|---|
| **Runtime** | Node.js 26 in the image (`node:26-alpine`), Express 5; `engines` requires Node >= 24 |
| **Depends on** | Temurin JDK 21 and Maven, both installed in the image; no outbound service dependencies |
| **Runs on** | Container / `docker compose`; not deployed to the estate cluster |

## Quick start

```bash
git clone https://github.com/nonagenticai/java-test-executor.git
cd java-test-executor
docker compose up -d --build
curl -s http://localhost:8088/health
```

`/health` is unauthenticated. Every other route requires an `X-Tenant-Id` header — an orchestrator marker, not cryptographic authentication.

## Usage

One source class and one JUnit 5 test, submitted over HTTP:

```bash
curl -s http://localhost:8088/execute \
  -H 'Content-Type: application/json' \
  -H 'X-Tenant-Id: local' \
  -d '{
    "code": "public class Main { public static int add(int a, int b) { return a + b; } }",
    "testFiles": {
      "MainTest.java": "import org.junit.jupiter.api.Test; import static org.junit.jupiter.api.Assertions.assertEquals; public class MainTest { @Test void adds() { assertEquals(3, Main.add(1, 2)); } }"
    },
    "framework": "junit5",
    "buildSystem": "maven"
  }'
```

`code` is written under `src/main/java/` and `testFiles` under `src/test/java/`. `success` is `true` only when compilation succeeds, the test command exits 0, at least one test is collected, and zero tests fail.

## API

All routes except `/health` (and the `/healthz`, `/ready` and `/` aliases) return HTTP 401 without an `X-Tenant-Id` header.

### `GET /health`

Returns service status and declared capabilities.

**Response 200:**
```json
{
  "status": "healthy",
  "service": "java-test-executor",
  "timestamp": "...",
  "version": "1.0.0",
  "capabilities": {
    "frameworks": ["junit5", "testng", "junit4"],
    "buildSystems": ["maven", "gradle"],
    "features": ["test_execution", "code_coverage", "static_analysis", "build_compilation", "dependency_management"]
  }
}
```

### `POST /execute`

Compiles source, runs tests, generates coverage and static analysis reports.

**Request body:**
| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `code` | string | — | Single-file Java source (legacy/simple path) |
| `mainFiles` | object | `{}` | Map of `relativePath → sourceContent` placed under `src/main/java/` |
| `testFiles` | object | `{}` | Map of `relativePath → sourceContent` placed under `src/test/java/` |
| `framework` | string | `"junit5"` | `junit5`, `testng`, or `junit4` |
| `buildSystem` | string | `"maven"` | `maven` or `gradle` |
| `dependencies` | array | `[]` | Extra dependency coordinates (currently unused by generated POM) |
| `buildConfig` | object | `{}` | Reserved for build config overrides |
| `options.generateCoverage` | bool | `true` | Run JaCoCo coverage report |
| `options.runStaticAnalysis` | bool | `true` | Run Checkstyle, PMD, SpotBugs |

At least one of `code`, `testFiles`, or `mainFiles` must be provided.

A **fast-path** short-circuits when `code` is exactly the literal `// test` (after trimming), returning immediately without spawning Java.

**Response 200:**
```json
{
  "executionId": "uuid",
  "framework": "junit5",
  "buildSystem": "maven",
  "startTime": "...",
  "duration": 12345,
  "success": true,
  "no_tests_run": false,
  "compilation": { "success": true, "output": "...", "errors": "..." },
  "tests": {
    "total": 3, "passed": 3, "failed": 0, "skipped": 0,
    "testFiles": [...], "failureDetails": [],
    "output": "...", "errors": "...", "executionSuccess": true
  },
  "coverage": {
    "instruction": { "covered": 10, "missed": 2, "total": 12, "percentage": "83.33" },
    "branch": { ... },
    "line": { ... }
  },
  "staticAnalysis": {
    "checkstyle": { "success": true, "output": "...", "errors": "..." },
    "pmd": { ... },
    "spotbugs": { ... }
  }
}
```

`success` is `true` only when compilation succeeds, the test command exits 0, at least one test is collected, and zero tests fail. `no_tests_run` reports a measured zero-test run, which is not a pass.

### `GET /frameworks`

Returns the supported testing frameworks, build systems, and capability flags.

### `POST /validate`

Compiles a single Java file with `javac` to check syntax validity.

**Request body:**
| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `code` | string | required | Java source code |
| `className` | string | `"TestClass"` | Class name (used as filename); must be a valid Java identifier |

**Response 200:**
```json
{
  "validationId": "uuid",
  "valid": true,
  "errors": [],
  "output": ""
}
```

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `8088` | HTTP listen port |
| `EXECUTION_TIMEOUT` | `300` | Per-command timeout in seconds |
| `TEST_WORKSPACE` | `/app/test_workspace` | Directory for ephemeral project scaffolds |
| `REPORTS_DIR` | `/app/reports` | Directory for generated reports |

The workspace and reports directories must be writable by the process.

## Development

```bash
npm ci
npm run lint
npm test
```

Node.js 24 or newer is required. `npm test` runs eslint through `pretest`, then the Jest suite configured in `jest.config.cjs`.

## Architecture

```
coding-testing (port 8689)
  ── HTTP POST /execute ──▸  java-test-executor (port 8088)
                               │
                               ├─ scaffolds Maven/Gradle project in /app/test_workspace/<uuid>
                               ├─ mvn compile / mvn test / mvn jacoco:report
                               ├─ parses surefire XML + JaCoCo XML
                               ├─ runs checkstyle / pmd / spotbugs
                               └─ returns JSON results; a completed run schedules workspace cleanup after 60 s
```

- **Build systems:** Maven is installed in the image. The Gradle code path exists, but Gradle is not installed; a Gradle request needs a `gradle` binary on `PATH`.
- **Concurrency:** Build commands (mvn/gradle/javac) are serialized through an in-process queue to avoid repository lock conflicts. Non-build commands execute immediately.
- **Timeout:** Each command has a configurable timeout (default 300s). On timeout the child process is killed with SIGTERM.

## Docker

**Image:** `ghcr.io/nonagenticai/java-test-executor`

One multi-stage Dockerfile: the `toolchain` stage is `eclipse-temurin:21-jdk-alpine` plus `maven`, `bash`, `libatomic` and the node binary the service runs on; the `app` stage is the service. (It used to be a separately published base image pinned by digest — folded into one artefact for the public repository.)

```bash
# standalone
docker compose up -d

# alongside the other services (any compose project that shares the network)
docker compose up -d java-test-executor
```

## Dependencies on Other Services

- **Consumed by:** `coding-testing` (port 8689), which sets `JAVA_TEST_SERVICE_URL=http://java-test-executor:8088`
- **No outbound service dependencies.** This service only needs a JDK and Maven/Gradle on the filesystem.

## CI/CD

GitHub Actions (`.github/workflows/ci.yml` → `nonagenticai/ci-workflows`' public `node-service.yml` archetype) on GitHub-hosted runners:
1. Secret scan and private-infrastructure scan
2. `npm ci`, eslint, the jest suite
3. Image build and a `/health` smoke against it
4. From `main`: push `sha-<short-commit>` + `latest` to `ghcr.io/nonagenticai/java-test-executor` with a SLSA provenance attestation

There is no deploy job: this service is retired from the estate's cluster, and the repository is published so its tests, image build and job contract stay reproducible.

## Security

Report vulnerabilities privately through the repository's Security tab — see the organisation policy in
[`nonagenticai/.github/SECURITY.md`](https://github.com/nonagenticai/.github/blob/main/SECURITY.md). Do not open a public issue for a security problem.

The `X-Tenant-Id` guard is a routing marker, not authentication. The service is stateless and expects network-level isolation.

## Contributing

Issues and pull requests are welcome. See
[`CONTRIBUTING.md`](https://github.com/nonagenticai/.github/blob/main/CONTRIBUTING.md) for the
organisation-wide rules; this repository's own commands are in **Development** above.

## License

Apache-2.0 — see [`LICENSE`](LICENSE). The code needs no licence key to build, test or run, and contains no licence-enforcement code: the Apache-2.0 licence is the only licence that applies, and no licence server is involved.
