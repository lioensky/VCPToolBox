const { spawn } = require('child_process');
const path = require('path');

/**
 * Executes a command and returns a promise that resolves on successful completion.
 * @param {string} command - The command to execute.
 * @param {string[]} args - The arguments for the command.
 * @returns {Promise<void>}
 */
function executeCommand(command, args) {
    return new Promise((resolve, reject) => {
        const process = spawn(command, args, {
            stdio: 'inherit', // Show script output in the main console
            shell: true,
            cwd: path.resolve(__dirname) // Ensure consistent working directory
        });

        process.on('close', (code) => {
            if (code === 0) {
                resolve();
            } else {
                reject(new Error(`Script exited with code ${code}`));
            }
        });

        process.on('error', (err) => {
            reject(new Error(`Failed to start script: ${err.message}`));
        });
    });
}

/**
 * Parses the POST_RUN_SCRIPTS environment variable and executes the scripts sequentially.
 */
async function runPostScripts() {
    const scriptsEnv = process.env.POST_RUN_SCRIPTS;

    if (!scriptsEnv || scriptsEnv.trim() === '') {
        process.stderr.write('POST_RUN_SCRIPTS is not defined or empty, skipping.\n');
        return;
    }

    const projectRoot = path.resolve(__dirname);
    const scriptPaths = scriptsEnv.split('|').map(s => s.trim()).filter(Boolean);

    if (scriptPaths.length > 0) {
        process.stderr.write(`--- Starting Post-Execution Scripts (${scriptPaths.length}) ---\n`);
    }

    for (const scriptPath of scriptPaths) {
        try {
            let finalPath = scriptPath.replace('@/', projectRoot + path.sep);
            finalPath = path.resolve(finalPath); // Ensure the path is absolute

            process.stderr.write(`\n[POST-RUN] Executing: node ${path.basename(finalPath)}\n`);
            
            await executeCommand('node', [finalPath]);
            
            process.stderr.write(`[POST-RUN] Finished: ${path.basename(finalPath)}\n`);

        } catch (error) {
            process.stderr.write(`\n[POST-RUN] ERROR: Script '${scriptPath}' failed: ${error.message}\n`);
            process.stderr.write('[POST-RUN] Halting further script execution.\n');
            // Re-throw to let the main process know something went wrong.
            throw error; 
        }
    }

    if (scriptPaths.length > 0) {
        process.stderr.write('\n--- All Post-Execution Scripts Finished Successfully ---\n');
    }
}

module.exports = { runPostScripts };