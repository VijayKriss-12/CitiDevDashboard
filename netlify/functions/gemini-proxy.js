export const handler = async (event) => {
  // 1. Parse the prompt from the frontend request
  const { prompt } = JSON.parse(event.body);

  // 2. Grab the key from Environment Variables
  const API_KEY = process.env.GEMINI_API;
  

  try {
    const response = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": API_KEY // Using the header approach here
        },
        body: JSON.stringify({
          contents: [
            {
              parts: [{ text: prompt }]
            }
          ]
        })
      }
    );

    const data = await response.json();

    // 3. Return the specific text response to your app.js
    // Gemini returns: data.candidates[0].content.parts[0].text
    const replyText = data.candidates[0].content.parts[0].text;

    return {
      statusCode: 200,
      body: JSON.stringify({ reply: replyText })
    };
  } catch (error) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Failed to fetch from Gemini" })
    };
  }
};
