const express = require("express");
const fs = require("fs").promises;
const path = require("path");

module.exports = function(options) {
    const router = express.Router();
    const { tvsDirPath } = options;
    const TVS_FILES_DIR = tvsDirPath;

    function isPathInsideRoot(targetPath, rootPath) {
        const resolvedTarget = path.resolve(targetPath);
        const resolvedRoot = path.resolve(rootPath);
        return resolvedTarget === resolvedRoot || resolvedTarget.startsWith(resolvedRoot + path.sep);
    }

    function safeResolveUnderTVSTxt(relativePath = "") {
        const normalizedRelativePath = String(relativePath || "").replace(/\/g, "/");
        const resolved = path.resolve(TVS_FILES_DIR, normalizedRelativePath);
        if (!isPathInsideRoot(resolved, TVS_FILES_DIR)) {
            throw new Error("Invalid path: outside TVS root");
        }
        if (resolved === path.resolve(TVS_FILES_DIR)) {
            throw new Error("Invalid path: target resolves to root directory");
        }
        return resolved;
    }

    // GET list of TVS files
    router.get("/tvsvars", async (req, res) => {
        try {
            await fs.mkdir(TVS_FILES_DIR, { recursive: true });
            const files = await fs.readdir(TVS_FILES_DIR);
            const txtFiles = files.filter(file => file.toLowerCase().endsWith(".txt"));
            res.json({ files: txtFiles });
        } catch (error) {
            console.error("[AdminPanelRoutes API] Error listing TVS files:", error);
            res.status(500).json({ error: "Failed to list TVS files", details: error.message });
        }
    });

    // GET specific TVS file content
    router.get("/tvsvars/:fileName", async (req, res) => {
        const { fileName } = req.params;
        if (!fileName.toLowerCase().endsWith(".txt")) {
            return res.status(400).json({ error: "Invalid file name. Must be a .txt file." });
        }
        try {
            const filePath = safeResolveUnderTVSTxt(fileName);
            await fs.access(filePath);
            const content = await fs.readFile(filePath, "utf-8");
            res.json({ content });
        } catch (error) {
            if (error.message && error.message.startsWith("Invalid path")) {
                return res.status(403).json({ error: error.message });
            }
            if (error.code === "ENOENT") res.status(404).json({ error: "TVS file not found." });
            else res.status(500).json({ error: "Failed to read TVS file", details: error.message });
        }
    });

    // POST save specific TVS file content
    router.post("/tvsvars/:fileName", async (req, res) => {
        const { fileName } = req.params;
        const { content: reqContent } = req.body;
        if (!fileName.toLowerCase().endsWith(".txt")) {
            return res.status(400).json({ error: "Invalid file name." });
        }
        if (typeof reqContent !== "string") return res.status(400).json({ error: "Invalid request body." });
        try {
            const filePath = safeResolveUnderTVSTxt(fileName);
            await fs.mkdir(TVS_FILES_DIR, { recursive: true });
            await fs.writeFile(filePath, reqContent, "utf-8");
            res.json({ message: "TVS file '" + fileName + "' saved successfully." });
        } catch (error) {
            if (error.message && error.message.startsWith("Invalid path")) {
                return res.status(403).json({ error: error.message });
            }
            res.status(500).json({ error: "Failed to save TVS file", details: error.message });
        }
    });

    // DELETE specific TVS file
    router.delete("/tvsvars/:fileName", async (req, res) => {
        const { fileName } = req.params;
        if (!fileName.toLowerCase().endsWith(".txt")) {
            return res.status(400).json({ error: "Invalid file name." });
        }

        try {
            const filePath = safeResolveUnderTVSTxt(fileName);
            await fs.unlink(filePath);
            res.json({ message: "TVS file '" + fileName + "' deleted successfully." });
        } catch (error) {
            if (error.message && error.message.startsWith("Invalid path")) {
                return res.status(403).json({ error: error.message });
            }
            if (error.code === "ENOENT") {
                return res.status(404).json({ error: "TVS file not found." });
            }
            res.status(500).json({ error: "Failed to delete TVS file", details: error.message });
        }
    });

    return router;
}