const assert = require('node:assert/strict');
const test = require('node:test');

const { classifyToolEffect } = require('../modules/toolEffectClassifier');

test('ServerSearchController defaults to read_local', () => {
    const result = classifyToolEffect({
        toolName: 'ServerSearchController',
        approvalDecision: {
            requestedToolName: 'ServerSearchController',
            canonicalToolName: 'ServerSearchController'
        },
        toolArgs: {}
    });

    assert.equal(result.effectClass, 'read_local');
    assert.equal(result.effectConfidence, 'explicit');
    assert.deepEqual(result.effectEvidenceSources, ['tool_default:ServerSearchController']);
});

test('ServerCodeSearcher defaults to read_local', () => {
    const result = classifyToolEffect({
        toolName: 'ServerCodeSearcher',
        approvalDecision: {
            requestedToolName: 'ServerCodeSearcher',
            canonicalToolName: 'ServerCodeSearcher'
        },
        toolArgs: {}
    });

    assert.equal(result.effectClass, 'read_local');
    assert.equal(result.effectConfidence, 'explicit');
    assert.deepEqual(result.effectEvidenceSources, ['tool_default:ServerCodeSearcher']);
});

test('ServerPowerShellExecutor remains execute_shell even for Get-ChildItem', () => {
    const result = classifyToolEffect({
        toolName: 'ServerPowerShellExecutor',
        approvalDecision: {
            requestedToolName: 'PowerShellExecutor',
            canonicalToolName: 'ServerPowerShellExecutor'
        },
        toolArgs: {
            command: 'Get-ChildItem'
        }
    });

    assert.equal(result.effectClass, 'execute_shell');
    assert.equal(result.effectConfidence, 'explicit');
    assert.equal(result.command, 'Get-ChildItem');
});

test('ServerFileOperator command overrides classify known operations explicitly', () => {
    const readResult = classifyToolEffect({
        toolName: 'ServerFileOperator',
        approvalDecision: {
            requestedToolName: 'FileOperator',
            canonicalToolName: 'ServerFileOperator'
        },
        toolArgs: {
            command: 'ReadFile'
        }
    });
    const writeResult = classifyToolEffect({
        toolName: 'ServerFileOperator',
        approvalDecision: {
            requestedToolName: 'FileOperator',
            canonicalToolName: 'ServerFileOperator'
        },
        toolArgs: {
            command: 'WriteFile'
        }
    });
    const deleteResult = classifyToolEffect({
        toolName: 'ServerFileOperator',
        approvalDecision: {
            requestedToolName: 'FileOperator',
            canonicalToolName: 'ServerFileOperator'
        },
        toolArgs: {
            command: 'DeleteFile'
        }
    });

    assert.equal(readResult.effectClass, 'read_local');
    assert.equal(writeResult.effectClass, 'write_local');
    assert.equal(deleteResult.effectClass, 'delete_or_destructive');
});

test('ServerFileOperator read-oriented commands keep explicit read classifications', () => {
    const listAllowedDirectoriesResult = classifyToolEffect({
        toolName: 'ServerFileOperator',
        approvalDecision: {
            requestedToolName: 'FileOperator',
            canonicalToolName: 'ServerFileOperator'
        },
        toolArgs: {
            command: 'ListAllowedDirectories'
        }
    });
    const listDirectoryResult = classifyToolEffect({
        toolName: 'ServerFileOperator',
        approvalDecision: {
            requestedToolName: 'FileOperator',
            canonicalToolName: 'ServerFileOperator'
        },
        toolArgs: {
            command: 'ListDirectory'
        }
    });
    const fileInfoResult = classifyToolEffect({
        toolName: 'ServerFileOperator',
        approvalDecision: {
            requestedToolName: 'FileOperator',
            canonicalToolName: 'ServerFileOperator'
        },
        toolArgs: {
            command: 'FileInfo'
        }
    });
    const searchFilesResult = classifyToolEffect({
        toolName: 'ServerFileOperator',
        approvalDecision: {
            requestedToolName: 'FileOperator',
            canonicalToolName: 'ServerFileOperator'
        },
        toolArgs: {
            command: 'SearchFiles'
        }
    });

    assert.equal(listAllowedDirectoriesResult.effectClass, 'read_local');
    assert.equal(listDirectoryResult.effectClass, 'read_local');
    assert.equal(fileInfoResult.effectClass, 'read_local');
    assert.equal(searchFilesResult.effectClass, 'read_local');
});

test('ServerFileOperator WebReadFile is treated as write_local because it persists downloaded content', () => {
    const result = classifyToolEffect({
        toolName: 'ServerFileOperator',
        approvalDecision: {
            requestedToolName: 'FileOperator',
            canonicalToolName: 'ServerFileOperator'
        },
        toolArgs: {
            command: 'WebReadFile'
        }
    });

    assert.equal(result.effectClass, 'write_local');
    assert.equal(result.effectConfidence, 'explicit');
    assert.deepEqual(result.effectEvidenceSources, ['command_override:ServerFileOperator:WebReadFile']);
});

test('ServerFileOperator write-oriented commands keep explicit write classifications', () => {
    const appendFileResult = classifyToolEffect({
        toolName: 'ServerFileOperator',
        approvalDecision: {
            requestedToolName: 'FileOperator',
            canonicalToolName: 'ServerFileOperator'
        },
        toolArgs: {
            command: 'AppendFile'
        }
    });
    const editFileResult = classifyToolEffect({
        toolName: 'ServerFileOperator',
        approvalDecision: {
            requestedToolName: 'FileOperator',
            canonicalToolName: 'ServerFileOperator'
        },
        toolArgs: {
            command: 'EditFile'
        }
    });
    const createDirectoryResult = classifyToolEffect({
        toolName: 'ServerFileOperator',
        approvalDecision: {
            requestedToolName: 'FileOperator',
            canonicalToolName: 'ServerFileOperator'
        },
        toolArgs: {
            command: 'CreateDirectory'
        }
    });
    const downloadFileResult = classifyToolEffect({
        toolName: 'ServerFileOperator',
        approvalDecision: {
            requestedToolName: 'FileOperator',
            canonicalToolName: 'ServerFileOperator'
        },
        toolArgs: {
            command: 'DownloadFile'
        }
    });

    assert.equal(appendFileResult.effectClass, 'write_local');
    assert.equal(editFileResult.effectClass, 'write_local');
    assert.equal(createDirectoryResult.effectClass, 'write_local');
    assert.equal(downloadFileResult.effectClass, 'write_local');
});

test('ServerFileOperator rename and move commands stay destructive', () => {
    const moveFileResult = classifyToolEffect({
        toolName: 'ServerFileOperator',
        approvalDecision: {
            requestedToolName: 'FileOperator',
            canonicalToolName: 'ServerFileOperator'
        },
        toolArgs: {
            command: 'MoveFile'
        }
    });
    const renameFileResult = classifyToolEffect({
        toolName: 'ServerFileOperator',
        approvalDecision: {
            requestedToolName: 'FileOperator',
            canonicalToolName: 'ServerFileOperator'
        },
        toolArgs: {
            command: 'RenameFile'
        }
    });

    assert.equal(moveFileResult.effectClass, 'delete_or_destructive');
    assert.equal(renameFileResult.effectClass, 'delete_or_destructive');
});

test('ServerFileOperator explicit command matrix stays stable across covered commands', () => {
    const cases = [
        ['ListAllowedDirectories', 'read_local'],
        ['ReadFile', 'read_local'],
        ['WebReadFile', 'write_local'],
        ['ListDirectory', 'read_local'],
        ['FileInfo', 'read_local'],
        ['SearchFiles', 'read_local'],
        ['WriteFile', 'write_local'],
        ['WriteEscapedFile', 'write_local'],
        ['AppendFile', 'write_local'],
        ['EditFile', 'write_local'],
        ['CopyFile', 'write_local'],
        ['CreateDirectory', 'write_local'],
        ['DownloadFile', 'write_local'],
        ['ApplyDiff', 'write_local'],
        ['UpdateHistory', 'write_local'],
        ['CreateCanvas', 'write_local'],
        ['MoveFile', 'delete_or_destructive'],
        ['RenameFile', 'delete_or_destructive'],
        ['DeleteFile', 'delete_or_destructive']
    ];

    for (const [command, expectedEffectClass] of cases) {
        const result = classifyToolEffect({
            toolName: 'FileOperator',
            approvalDecision: {
                requestedToolName: 'FileOperator',
                canonicalToolName: 'ServerFileOperator'
            },
            toolArgs: {
                command
            }
        });

        assert.equal(result.command, command);
        assert.equal(result.effectClass, expectedEffectClass);
        assert.equal(result.effectConfidence, 'explicit');
        assert.deepEqual(result.effectEvidenceSources, [`command_override:ServerFileOperator:${command}`]);
    }
});

test('unmapped ServerFileOperator commands stay conservative', () => {
    const result = classifyToolEffect({
        toolName: 'ServerFileOperator',
        approvalDecision: {
            requestedToolName: 'FileOperator',
            canonicalToolName: 'ServerFileOperator'
        },
        toolArgs: {
            command: 'UnmappedCommand'
        }
    });

    assert.equal(result.effectClass, 'delete_or_destructive');
    assert.equal(result.effectConfidence, 'derived');
    assert.deepEqual(result.effectEvidenceSources, ['tool_family_default:ServerFileOperator']);
});

test('numbered commands are classified and keep destructive batch operations conservative', () => {
    const result = classifyToolEffect({
        toolName: 'FileOperator',
        approvalDecision: {
            requestedToolName: 'FileOperator',
            canonicalToolName: 'ServerFileOperator'
        },
        toolArgs: {
            command1: 'ReadFile',
            command2: 'DeleteFile'
        }
    });

    assert.equal(result.command, 'DeleteFile');
    assert.equal(result.effectClass, 'delete_or_destructive');
    assert.equal(result.effectConfidence, 'explicit');
    assert.deepEqual(result.effectEvidenceSources, ['command_override:ServerFileOperator:DeleteFile']);
});

test('numbered FileOperator commands keep explicit write mapping when covered commands tie on effect class', () => {
    const result = classifyToolEffect({
        toolName: 'FileOperator',
        approvalDecision: {
            requestedToolName: 'FileOperator',
            canonicalToolName: 'ServerFileOperator'
        },
        toolArgs: {
            command1: 'WebReadFile',
            command2: 'WriteFile'
        }
    });

    assert.equal(result.command, 'WebReadFile');
    assert.equal(result.effectClass, 'write_local');
    assert.equal(result.effectConfidence, 'explicit');
    assert.deepEqual(result.effectEvidenceSources, ['command_override:ServerFileOperator:WebReadFile']);
});

test('numbered PowerShell commands still classify as execute_shell', () => {
    const result = classifyToolEffect({
        toolName: 'PowerShellExecutor',
        approvalDecision: {
            requestedToolName: 'PowerShellExecutor',
            canonicalToolName: 'ServerPowerShellExecutor'
        },
        toolArgs: {
            command1: 'Get-ChildItem'
        }
    });

    assert.equal(result.command, 'Get-ChildItem');
    assert.equal(result.effectClass, 'execute_shell');
    assert.equal(result.effectConfidence, 'explicit');
});

test('unknown tools fall back to unknown conservatively', () => {
    const result = classifyToolEffect({
        toolName: 'UnknownTool',
        approvalDecision: {
            requestedToolName: 'UnknownTool',
            canonicalToolName: 'UnknownTool'
        },
        toolArgs: {
            command: 'Whatever'
        }
    });

    assert.equal(result.effectClass, 'unknown');
    assert.equal(result.effectConfidence, 'unknown');
    assert.deepEqual(result.effectEvidenceSources, ['fallback:unknown']);
});
