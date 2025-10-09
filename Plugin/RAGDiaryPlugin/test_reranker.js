const axios = require('axios');
const dotenv = require('dotenv');
const path = require('path');
const fs = require('fs');

// --- Main Test Function ---
async function testRerankerAPI() {
    try {
        // 1. Load Configuration
        console.log('Loading configuration from config.env...');
        const configPath = path.join(__dirname, 'config.env');
        if (!fs.existsSync(configPath)) {
            throw new Error(`Configuration file not found at: ${configPath}`);
        }
        const configContent = fs.readFileSync(configPath, 'utf-8');
        const config = dotenv.parse(configContent);

        const requiredKeys = ['RerankUrl', 'RerankApi', 'RerankModel'];
        for (const key of requiredKeys) {
            if (!config[key]) {
                throw new Error(`Missing required key in config.env: ${key}`);
            }
        }
        console.log('Configuration loaded successfully.');
        console.log(`- Model: ${config.RerankModel}`);
        console.log(`- URL: ${config.RerankUrl}`);

        // 2. Prepare the Request Data
        const rerankUrl = new URL('v1/rerank', config.RerankUrl).toString();
        const headers = {
            'Authorization': `Bearer ${config.RerankApi}`,
            'Content-Type': 'application/json',
        };
        const body = {
            model: config.RerankModel,
            query: "Apple",
            documents: [
                "A juicy red apple.",
                "The company Apple Inc. announced a new iPhone.",
                "Banana is a yellow fruit.",
                "I like to eat fruits.",
                "An apple a day keeps the doctor away."
            ]
        };

        console.log(`\nSending POST request to: ${rerankUrl}`);
        console.log('Request Body:', JSON.stringify(body, null, 2));

        // 3. Send the Request
        const response = await axios.post(rerankUrl, body, { headers });

        // 4. Print the Success Response
        console.log('\n--- SUCCESS ---');
        console.log('Status:', response.status, response.statusText);
        console.log('Response Data:', JSON.stringify(response.data, null, 2));

    } catch (error) {
        // 5. Print the Error Response
        console.error('\n--- ERROR ---');
        if (error.response) {
            // The request was made and the server responded with a status code
            // that falls out of the range of 2xx
            console.error('Status:', error.response.status, error.response.statusText);
            console.error('Response Data:', JSON.stringify(error.response.data, null, 2));
            console.error('Response Headers:', JSON.stringify(error.response.headers, null, 2));
        } else if (error.request) {
            // The request was made but no response was received
            console.error('No response received for the request.');
            console.error('Request details:', error.request);
        } else {
            // Something happened in setting up the request that triggered an Error
            console.error('Error Message:', error.message);
        }
    }
}

// --- Run the Test ---
testRerankerAPI();