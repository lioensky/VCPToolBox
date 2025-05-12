#!/usr/bin/env node
import { TavilyClient } from '@tavily/tavily-node'; // Using the official Node.js client
import { stdin } from 'process';

async function main() {
    let inputData = '';
    stdin.setEncoding('utf8');

    for await (const chunk of stdin) {
        inputData += chunk;
    }

    let output = {};

    try {
        if (!inputData.trim()) {
            throw new Error("No input data received from stdin.");
        }

        const data = JSON.parse(inputData);

        const query = data.query;
        const topic = data.topic || 'general'; // Default to 'general'
        const searchDepth = data.search_depth || 'basic'; // Default to 'basic'
        let maxResults = data.max_results || 5; // Default to 5

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
                maxResults = 5; // Default to 5 if invalid or out of range
            }
        } catch (e) {
            maxResults = 5; // Default if parsing fails
        }

        const apiKey = process.env.TavilyKey; // Use existing TavilyKey from config.env
        if (!apiKey) {
            throw new Error("TavilyKey environment variable not set in config.env.");
        }

        const client = new TavilyClient({ apiKey });

        const response = await client.search(query, {
            searchDepth: searchDepth,
            topic: topic,
            maxResults: maxResults,
            includeAnswer: false, // Usually just want results for AI processing
            includeRawContent: false,
            includeImages: false
        });

        // Tavily Node client returns a JSON-serializable object
        output = { status: "success", result: response };

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
    process.stdout.write(JSON.stringify(output));
}

main().catch(error => {
    // Catch any unhandled promise rejections from main
    process.stdout.write(JSON.stringify({ status: "error", error: `Unhandled Plugin Error: ${error.message || error}` }));
    process.exit(1); // Indicate failure
});