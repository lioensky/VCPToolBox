// VCPDistributedServer/Plugin/FileOperator/CodeValidator.js
const path = require('path');
const { ESLint } = require('eslint');
const stylelint = require('stylelint');
const js = require("@eslint/js");
const globals = require("globals");

// Initialize ESLint with the new "flat config" format, required for ESLint v9+.
const eslint = new ESLint({
  overrideConfigFile: true, // Prevents loading external eslint.config.js
  overrideConfig: [
    js.configs.recommended, // Start with the recommended rules
    {
      // Apply these settings to all matched files
      languageOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
        globals: {
          ...globals.node,   // Add Node.js environment globals
          ...globals.es2021, // Add ES2021 globals
        },
      },
    },
  ],
});

// Initialize Stylelint
// We provide a self-contained configuration to avoid external dependencies.
const stylelintConfig = {
  extends: 'stylelint-config-standard',
  rules: {
    // Add any project-specific overrides here
  },
};

/**
 * Asynchronously validates the code content based on its file type.
 * @param {string} filePath - The path to the file, used to determine the language.
 * @param {string} content - The code content to validate.
 * @returns {Promise<Array<Object>>} A promise that resolves to an array of validation results.
 */
async function validateCode(filePath, content) {
  const extension = path.extname(filePath).toLowerCase();
  let results = [];

  try {
    switch (extension) {
      case '.js':
      case '.ts': {
        const lintResults = await eslint.lintText(content, { filePath });
        // lintText returns an array; we process the first element for a single string.
        if (lintResults && lintResults[0]) {
          results = lintResults[0].messages.map(msg => ({
            line: msg.line,
            column: msg.column,
            severity: msg.severity === 2 ? 'error' : 'warning',
            message: msg.message,
            ruleId: msg.ruleId,
          }));
        }
        break;
      }

      case '.css': {
        const lintResult = await stylelint.lint({
          code: content,
          config: stylelintConfig,
          customSyntax: 'postcss-safe-parser', // Use a safe parser for potentially incomplete CSS
        });
        // Stylelint's output is slightly different, so we adapt it.
        if (lintResult && lintResult.results && lintResult.results[0]) {
          results = lintResult.results[0].warnings.map(w => ({
            line: w.line,
            column: w.column,
            severity: w.severity, // 'error' or 'warning'
            message: w.text,
            ruleId: w.rule,
          }));
        }
        break;
      }

      case '.py':
        // TODO: Implement Python linting (e.g., via child_process)
        console.error(`Validation for ${extension} files is not yet implemented.`);
        break;

      // Add other file types as needed
      
      default:
        // No validator for this file type, return empty array
        break;
    }
  } catch (error) {
    console.error(`Error during validation for ${filePath}:`, error);
    // Return a special error object in the results
    return [{
      line: 1,
      column: 1,
      severity: 'error',
      message: `Linter execution failed: ${error.message}`,
      ruleId: 'linter-error'
    }];
  }

  return results;
}

module.exports = {
  validateCode,
};