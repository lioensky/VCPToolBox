'use strict';

const { scanProject } = require('./modules/scanner');
const { buildSummaryFold } = require('./modules/reporter');

(async () => {
    try {
        const { index } = await scanProject();
        process.stdout.write(JSON.stringify(buildSummaryFold(index)));
    } catch (error) {
        console.error(`[PlaceholderExplorer] ${error.stack || error.message}`);
        process.exitCode = 1;
    }
})();
