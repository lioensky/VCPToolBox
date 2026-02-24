const vertexUrlRegex = /(?:https?:\/\/)?vertexaisearch\.cloud\.google\.com\/grounding-api-redirect\/[a-zA-Z0-9_-]+/g;

const testUrls = [
    "https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQEDfvfF3w7UXBhslj3tpr1dcv0nE5RwAKHOMcCyYXPUKq_8aqAsJYTCCX8uV1DCXjzWiCcX0XlCOST-Nt2SR7nJdxrv7LT-UDMuU-QvLn6TGb8sJs1C6Oy7AXRISteH6nNJGngKu41b9lLvNli8",
    "https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQEjfZatNJlaU3gp7VUi5meamj_Tdys8usJP4tD-0OeATYwQeLABIlhQ3vnhR1dbDvxEKyZ4D0EJfNF2sJ1TlkDWb_gUTIEwPj0AWAkkit1iMgRNePJwcinxAiqNdVWfBVNYjWGb5rhq2bkETA--hqsbpEkqhX832L66wOrVSIGrMcdP8ML0Q-cIo4qGZIU7h6Jy0wGKsEO-sS0wtFYx4ZWH2RU=",
    "https://vertexaisearch.cloud.google.com/grounding-api-redirect/AUZIYQG2ZElX2bZOfWpApzp2X_xSZPKhD-KkBD27KmQKfxChLVSw1zTMoZAHHyjO178LQCVbYPDjFGUOCvTCXfIvD9WxaU1lIfDT4DQ5qytXNjOMfXCwDQX6gwBTz3dUmCLAFV6bkJijo7UltqheRYsmBR-PclQebbiblllqeU5f4rfFmH5E"
];

testUrls.forEach(url => {
    const match = url.match(vertexUrlRegex);
    console.log(`URL: ${url}`);
    console.log(`Match: ${match ? match[0] : 'null'}`);
    console.log(`Full Match: ${match && match[0] === url}`);
    console.log('---');
});