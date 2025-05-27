#!/usr/bin/env node
const { tavily } = require('@tavily/core'); // Using the official Node.js client
const stdin = require('process').stdin;

async function main() {
    let inputData = '';
    stdin.setEncoding('utf8');

    stdin.on('data', function(chunk) {
        inputData += chunk;
    });

    stdin.on('end', async function() {
        let output = {};

        try {
            if (!inputData.trim()) {
                throw new Error("No input data received from stdin.");
            }

            const data = JSON.parse(inputData);

            const query = data.query;
            const topic = data.topic || 'general'; // Default to 'general'
            const searchDepth = data.search_depth || 'basic'; // Default to 'basic'
            let maxResults = data.max_results || 10; // Default to 10

            if (!query) {
                throw new Error("Missing required argument: query");
            }

            // Validate topic (optional, Tavily API might handle invalid ones)
            // const validTopics = ['general', 'news', 'finance', 'research', 'code'];
            // if (!validTopics.includes(topic)) {
            //     topic = 'general';
            // }

            // Validate search_depth
            const validDepths = ['basic', 'advanced'];
            if (!validDepths.includes(searchDepth)) {
                searchDepth = 'basic';
            }

            // Validate max_results
            try {
                maxResults = parseInt(maxResults, 10);
                if (isNaN(maxResults) || maxResults < 5 || maxResults > 100) {
                    maxResults = 10; // Default to 10 if invalid or out of range
                }
            } catch (e) {
                maxResults = 10; // Default if parsing fails
            }

            const apiKey = process.env.TavilyKey; // Use the correct environment variable name
            if (!apiKey) {
                throw new Error("TavilyKey environment variable not set.");
            }

            const tvly = tavily({ apiKey });

            const response = await tvly.search(query, {
                search_depth: searchDepth,
                topic: topic,
                max_results: maxResults,
                include_answer: false, // Usually just want results for AI processing
                include_raw_content: false,
                include_images: false
            });

            // Tavily Node client returns a JSON-serializable object
            // Ensure the result is a string for output
            output = { status: "success", result: JSON.stringify(response, null, 2) };

        } catch (e) {
            let errorMessage;
            if (e instanceof SyntaxError) {
                errorMessage = "Invalid JSON input.";
            } else if (e instanceof Error) {
                errorMessage = e.message;
            } else {
                errorMessage = "An unknown error occurred.";
            }
            output = { status: "error", error: `Tavily Search Error: ${errorMessage}` };
        }

        // Output JSON to stdout
        process.stdout.write(JSON.stringify(output, null, 2));
    });
}

main().catch(error => {
    // Catch any unhandled promise rejections from main
    process.stdout.write(JSON.stringify({ status: "error", error: `Unhandled Plugin Error: ${error.message || error}` }));
    process.exit(1); // Indicate failure
});
