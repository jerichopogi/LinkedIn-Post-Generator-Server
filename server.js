const express = require('express');
const cors = require('cors'); // Import the CORS middleware
const { createClient } = require('@supabase/supabase-js');
const Parser = require('rss-parser'); // Import the rss-parser
const axios = require('axios'); // Import axios for HTTP requests
require('dotenv').config(); // Ensure .env is loaded

const supabaseAdmin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const parser = new Parser(); // Initialize the RSS parser

const app = express();
const PORT = process.env.PORT || 5001;

// Enable CORS for requests from http://localhost:3000
app.use(cors({
  origin: 'http://localhost:3000', // Allow requests from this origin
}));

app.use(express.json());

// Endpoint to delete a user
app.delete('/delete-user/:userId', async (req, res) => {
  const { userId } = req.params;

  try {
    console.log(`Received request to delete user with ID: ${userId}`);

    const { error: authError } = await supabaseAdmin.auth.admin.deleteUser(userId);

    if (authError) {
      if (authError.message === 'User not found') {
        console.warn('User not found in authentication:', userId);
      } else {
        console.error('Error deleting user from authentication:', authError);
        return res.status(500).json({ message: `Failed to delete user from authentication: ${authError.message}` });
      }
    }

    const { data, error } = await supabaseAdmin
      .from('users')
      .delete()
      .eq('id', userId)
      .select('*');

    if (error) {
      console.error('Error deleting user from users table:', error);
      return res.status(500).json({ message: `Failed to delete user from users table: ${error.message}` });
    }

    if (!data || data.length === 0) {
      console.warn('No user was deleted from users table:', userId);
      return res.status(404).json({ message: 'No user was deleted from users table. Please ensure the user exists and you have the right permissions.' });
    }

    console.log('User deleted successfully:', userId);
    res.status(200).json({ message: 'User deleted successfully from both authentication and users table.' });
  } catch (error) {
    console.error('Unexpected error deleting user:', error);
    res.status(500).json({ message: 'Unexpected error occurred while deleting user.' });
  }
});

// New endpoint to validate RSS feed
app.post('/validate-feed', async (req, res) => {
  const { url } = req.body;

  try {
    const feed = await parser.parseURL(url);
    if (!feed) {
      return res.status(400).json({ message: 'Invalid RSS feed format' });
    }

    res.status(200).json({ message: 'RSS feed is valid' });
  } catch (error) {
    console.error('Error parsing RSS feed:', error);
    res.status(500).json({ message: 'Error parsing RSS feed' });
  }
});

// Check if today's articles have been loaded
app.get('/check-scan', async (req, res) => {
  try {
    const today = new Date();
    const startOfToday = new Date(today.setHours(0, 0, 0, 0)).toISOString();

    const { data, error } = await supabaseAdmin
      .from('scan_logs')
      .select('*')
      .gte('scan_date', startOfToday);

    if (error) {
      console.error('Error checking scan logs:', error);
      return res.status(500).json({ message: 'Error checking scan logs.' });
    }

    if (!data || data.length === 0) {
      return res.status(200).json({ scanDone: false });
    }

    return res.status(200).json({ scanDone: true });
  } catch (error) {
    console.error('Unexpected error checking scan logs:', error);
    res.status(500).json({ message: 'Unexpected error occurred while checking scan logs.' });
  }
});

// New endpoint to fetch today's articles from RSS feeds
app.post('/fetch-articles', async (req, res) => {
  const { feeds, openAiContext } = req.body; // OpenAI context from user settings

  try {
    const today = new Date();
    const startOfToday = new Date(today.setHours(0, 0, 0, 0)).toISOString();

    const articles = [];

    for (const feedUrl of feeds) {
      try {
        const feed = await parser.parseURL(feedUrl);
        const todayItems = feed.items.filter(item => new Date(item.pubDate) >= new Date(startOfToday));

        todayItems.forEach(item => {
          const articleId = `${feedUrl}_${item.guid}`; // Unique reference ID
          articles.push({
            id: articleId,
            title: item.title,
            link: item.link,
            pubDate: item.pubDate,
            content: item.content || item.contentSnippet || '', 
          });
        });

      } catch (error) {
        console.error(`Error fetching articles from ${feedUrl}:`, error);
        return res.status(500).json({ message: `Error fetching articles from ${feedUrl}` });
      }
    }

    // Create OpenAI prompt
    const prompt = `You act as an editor of the newsfeed and your job is to pick ${openAiContext}. You will be given article previews. When responding, list top 3 article IDs (as a comma-separated list - no text is necessary) you feel are the most prominent. \n\n`;
    const promptText = articles.map(article => `***ID ${article.id}: \n${article.content}\n***`).join('\n');

    // Check if the OpenAI API key is set
    if (!process.env.OPENAI_API_KEY) {
      console.error('OpenAI API key is not set.');
      return res.status(500).json({ message: 'OpenAI API key is not set.' });
    }

    // Call OpenAI API
    try {
      const openAiResponse = await axios.post('https://api.openai.com/v1/completions', {
        model: 'davinci-002', // Ensure you're using a valid model ID
        prompt: `${prompt}${promptText}`,
        max_tokens: 100,
        n: 1,
        stop: null,
        temperature: 0.7,
      }, {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
        },
      });

      // Log the complete OpenAI response
      console.log('OpenAI Response:', JSON.stringify(openAiResponse.data, null, 2));

      const topArticles = openAiResponse.data.choices[0].text.trim();
      console.log('Top 3 Articles:', topArticles);

      // Save the scan date
      await supabaseAdmin.from('scan_logs').insert([{ scan_date: new Date().toISOString() }]);

      res.status(200).json({ articles, topArticles });

    } catch (error) {
      console.error('Error during OpenAI request:', error.response ? error.response.data : error.message);
      res.status(500).json({ message: 'Error during OpenAI request' });
    }

  } catch (error) {
    console.error('Error fetching articles:', error);
    res.status(500).json({ message: 'Error fetching articles' });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});