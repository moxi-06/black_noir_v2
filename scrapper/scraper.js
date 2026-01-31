const axios = require('axios');
const cheerio = require('cheerio');

const BASE_URL = process.env.SCRAPER_URL || 'https://www.1tamilmv.rsvp/';

/**
 * Searches 1TamilMV and extracts links from topics.
 * @param {string} query The search query.
 */
async function searchWebsite(query) {
    try {
        const searchUrl = `${BASE_URL}index.php?/search/&q=${encodeURIComponent(query)}`;
        const response = await axios.get(searchUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            }
        });

        const $ = cheerio.load(response.data);
        const topics = [];

        // Extract topic links from search results
        $('h2[data-role="searchTitle"] a, .ipsStreamItem_title a').each((i, el) => {
            const href = $(el).attr('href');
            const title = $(el).text().trim();
            if (href && href.includes('topic/')) {
                topics.push({ title, href });
            }
        });

        if (topics.length === 0) return [];

        // Limit to top 10 topics for better search coverage
        const topTopics = topics.slice(0, 10);
        const results = [];

        for (const topic of topTopics) {
            try {
                const topicResponse = await axios.get(topic.href, {
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
                    }
                });
                const $t = cheerio.load(topicResponse.data);
                const links = [];

                $t('a').each((i, el) => {
                    const href = $t(el).attr('href');
                    const text = $t(el).text().trim();
                    if (href) {
                        if (href.startsWith('magnet:')) {
                            links.push({ type: 'Magnet', url: href, label: text || 'Magnet Link' });
                        } else if (href.includes('drive.google.com')) {
                            links.push({ type: 'GDrive', url: href, label: text || 'GDrive Link' });
                        } else if (href.includes('hubcloud') || href.includes('gdflix') || href.includes('cyberloom')) {
                            links.push({ type: 'Direct', url: href, label: text || 'Cloud Link' });
                        }
                    }
                });

                if (links.length > 0) {
                    results.push({
                        title: topic.title,
                        links: links.slice(0, 15) // Limit links per topic
                    });
                }
            } catch (err) {
                console.error(`Error scraping topic ${topic.href}:`, err.message);
            }
        }

        return results;
    } catch (error) {
        console.error('Scraper Error:', error.message);
        return [];
    }
}

module.exports = { searchWebsite };
