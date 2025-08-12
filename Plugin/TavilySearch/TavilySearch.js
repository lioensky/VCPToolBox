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
            const searchDepth = 'advanced'; // Default to 'advanced'
            let maxResults = data.max_results || 10; // Default to 10
            const includeRawContent = data.include_raw_content;
            const startDate = data.start_date;
            const endDate = data.end_date;

            if (!query) {
                throw new Error("Missing required argument: query");
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

            const searchOptions = {
                search_depth: searchDepth,
                topic: topic,
                max_results: maxResults,
                include_answer: false, // Usually just want results for AI processing
                include_images: true,
                include_image_descriptions: true,
            };

            if (includeRawContent === "text" || includeRawContent === "markdown") {
                searchOptions.include_raw_content = includeRawContent;
            }

            if (startDate) {
                searchOptions.start_date = startDate;
            }

            if (endDate) {
                searchOptions.end_date = endDate;
            }

            const response = await tvly.search(query, searchOptions);

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