const os = require('os');
const path = require('path');
const fs = require('fs');

// Set TEST_WORKSPACE to a temp dir so /execute and /validate don't try /app
const workspace = path.join(os.tmpdir(), 'java-test-executor-workspace');
const reportsDir = path.join(os.tmpdir(), 'java-test-executor-reports');

process.env.TEST_WORKSPACE = workspace;
process.env.REPORTS_DIR = reportsDir;

// Pre-create the directories
fs.mkdirSync(workspace, { recursive: true });
fs.mkdirSync(reportsDir, { recursive: true });
