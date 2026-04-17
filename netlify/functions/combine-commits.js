const fetch = require('node-fetch');

exports.handler = async (event) => {
    try {
        // ✅ Handle preflight (CORS)
        if (event.httpMethod === 'OPTIONS') {
            return {
                statusCode: 200,
                headers: corsHeaders(),
                body: ''
            };
        }

        // ✅ Safe body parsing
        let body = {};

        if (event.body) {
            try {
                body = typeof event.body === 'string'
                    ? JSON.parse(event.body)
                    : event.body;
            } catch (err) {
                return {
                    statusCode: 400,
                    headers: corsHeaders(),
                    body: JSON.stringify({ error: "Invalid JSON body" })
                };
            }
        }

        const commits = body.commits;

        if (!commits || !Array.isArray(commits) || commits.length === 0) {
            return {
                statusCode: 400,
                headers: corsHeaders(),
                body: JSON.stringify({ error: "No commits provided" })
            };
        }

       
        const GIT_TOKEN = process.env.GITHUB_TOKEN;

        if (!GIT_TOKEN) {
            return {
                statusCode: 500,
                headers: corsHeaders(),
                body: JSON.stringify({ error: "Missing GITHUB_TOKEN" })
            };
        }

        let combinedDiff = "";
        let fileMap = {};

        const url = `https://api.github.com/repos/Vijaykrishnan2000/CHAT-API-Website/commits/`;

        // 🔥 Loop commits
        for (const commit of commits) {
            if (!commit.url) continue;

            const res = await fetch(`https://api.github.com/repos/Vijaykrishnan2000/CHAT-API-Website/commits/${commit.sha}`, {
                headers: {
                    Authorization: `Bearer ${GIT_TOKEN}`,
                    Accept: 'application/vnd.github.v3+json'
                }
            });

            const data = await res.json();

            if (!data.files) continue;

            for (const file of data.files) {
                if (!file.patch) continue;

                // Group per file
                if (!fileMap[file.filename]) {
                    fileMap[file.filename] = "";
                }

                fileMap[file.filename] += `\n\n// Commit: ${commit.sha}\n`;
                fileMap[file.filename] += file.patch;

                // Combined view (for LLM)
                combinedDiff += `\n\n### ${file.filename}\n`;
                combinedDiff += file.patch;
            }
        }

        return {
            statusCode: 200,
            headers: corsHeaders(),
            body: JSON.stringify({
                message: "Combined diff generated",
                combinedDiff,
                files: fileMap
            })
        };

    } catch (error) {
        return {
            statusCode: 500,
            headers: corsHeaders(),
            body: JSON.stringify({
                error: error.message,
                debug: {
                    body: event.body
                }
            })
        };
    }
};

// ✅ CORS helper
function corsHeaders() {
    return {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Allow-Methods": "POST, OPTIONS"
    };
}