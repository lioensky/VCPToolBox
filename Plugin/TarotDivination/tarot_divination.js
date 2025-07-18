#!/usr/bin/env node

const fs = require('fs').promises;
const path = require('path');
const lunarCalendar = require('chinese-lunar-calendar');

// --- Configuration (from environment variables set by Plugin.js) ---
const PROJECT_BASE_PATH = process.env.PROJECT_BASE_PATH;
const SERVER_PORT = process.env.PORT; // Corrected from SERVER_PORT to PORT
const IMAGESERVER_IMAGE_KEY = process.env.Image_Key; // Corrected to match the key from ImageServer plugin
const VAR_HTTP_URL = process.env.VarHttpUrl;

// --- Helper Functions ---

/**
 * Creates a seeded pseudo-random number generator (PRNG) using the Mulberry32 algorithm.
 * This ensures that for the same seed, the sequence of numbers will be identical.
 * @param {string} seed The seed string to initialize the PRNG.
 * @returns {function(): number} A function that returns a pseudo-random float between 0 and 1.
 */
function createSeededRandom(seed) {
    let h = 1779033703 ^ seed.length;
    for (let i = 0; i < seed.length; i++) {
        h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
        h = h << 13 | h >>> 19;
    }

    return function() {
        h = Math.imul(h ^ h >>> 16, 2246822507);
        h = Math.imul(h ^ h >>> 13, 3266489909);
        return ((h ^= h >>> 16) >>> 0) / 4294967296;
    }
}


/**
 * Gathers various environmental and temporal factors to create a unique seed for divination.
 * @returns {Promise<object>} A promise that resolves to an object containing the random generator, a summary of factors, and the factors themselves.
 */
async function getDivinationFactors(fateCheckNumber = null) {
    const weatherCachePath = path.join(PROJECT_BASE_PATH, 'Plugin', 'WeatherReporter', 'weather_cache.json');
    let weatherData = {};
    let factorsSummary = "占卜因素：\n";
    const now = new Date();

    // --- Fate Check Number ---
    if (fateCheckNumber !== null && !isNaN(parseInt(fateCheckNumber))) {
        factorsSummary += `- 命运检定数: ${fateCheckNumber}\n`;
    }

    // --- Time Factors ---
    const timeFactors = {
        year: now.getFullYear(),
        month: now.getMonth() + 1,
        day: now.getDate(),
        hour: now.getHours(),
        minute: now.getMinutes(),
        second: now.getSeconds(),
        millisecond: now.getMilliseconds()
    };
    factorsSummary += `- 时间: ${now.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })} (中国标准时间)\n`;

    // --- Lunar Factors ---
    const lunarDate = lunarCalendar.getLunar(timeFactors.year, timeFactors.month, timeFactors.day);
    const lunarFactors = {
        lunarMonth: lunarDate.lunarMonth,
        lunarDay: lunarDate.lunarDay,
        zodiac: lunarDate.zodiac,
        solarTerm: lunarDate.solarTerm || '无',
        isFestive: (lunarDate.lunarFestival || lunarDate.solarFestival) ? 1 : 0,
        ganzhiYear: lunarDate.ganzhi ? lunarDate.ganzhi.year : '',
        ganzhiMonth: lunarDate.ganzhi ? lunarDate.ganzhi.month : '',
        ganzhiDay: lunarDate.ganzhi ? lunarDate.ganzhi.day : ''
    };
    const ganzhiYearText = lunarFactors.ganzhiYear ? `（${lunarFactors.ganzhiYear}）` : '';
    let festivalInfo = `${lunarDate.lunarYear}${lunarFactors.zodiac}年${lunarDate.lunarMonthName && lunarDate.lunarDayName ? ` ${lunarDate.lunarMonthName}${lunarDate.lunarDayName}` : ''}`;
    if (lunarDate.solarTerm) festivalInfo += ` | 节气: ${lunarDate.solarTerm}`;
    if (lunarDate.lunarFestival) festivalInfo += ` | 传统节日: ${lunarDate.lunarFestival}`;
    factorsSummary += `- 农历: ${festivalInfo}\n`;

    // --- Weather, Air, Sun, Moon Factors ---
    let weatherFactors = {
        temp: 25, humidity: 60, windSpeed: 10, windDir: '南风', pop: 0,
        cloud: 50, moonIllumination: 50, isRainOrSnow: 0,
        aqi: 50, solarElevation: 0, hasWarning: 0
    };

    try {
        const weatherContent = await fs.readFile(weatherCachePath, 'utf-8');
        weatherData = JSON.parse(weatherContent);
        const hourlyWeather = weatherData.hourly?.find(h => new Date(h.fxTime) > now);
        const moonPhase = weatherData.moon?.moonPhase?.filter(p => new Date(p.fxTime) <= now).pop();
        const airQuality = weatherData.airQuality;
        const solarAngle = weatherData.solarAngle;
        const warnings = weatherData.warning?.filter(w => w.status === 'active');

        if (hourlyWeather) {
            weatherFactors.temp = parseFloat(hourlyWeather.temp) || 25;
            weatherFactors.humidity = parseFloat(hourlyWeather.humidity) || 60;
            weatherFactors.windSpeed = parseFloat(hourlyWeather.windSpeed) || 10;
            weatherFactors.windDir = hourlyWeather.windDir || '未知';
            weatherFactors.pop = parseFloat(hourlyWeather.pop) || 0;
            weatherFactors.cloud = parseFloat(hourlyWeather.cloud) || 50;
            if (hourlyWeather.text && (hourlyWeather.text.includes('雨') || hourlyWeather.text.includes('雪'))) {
                weatherFactors.isRainOrSnow = 1;
            }
            factorsSummary += `- 天气: ${hourlyWeather.text}, 气温: ${weatherFactors.temp}°C, 湿度: ${weatherFactors.humidity}%, 降水概率: ${weatherFactors.pop}%\n`;
            factorsSummary += `- 风: ${weatherFactors.windDir} ${hourlyWeather.windScale}级 (风速 ${weatherFactors.windSpeed} km/h)\n`;
        }
        if (moonPhase) {
            weatherFactors.moonIllumination = parseFloat(moonPhase.illumination) || 50;
            factorsSummary += `- 月相: ${moonPhase.name} (光照: ${weatherFactors.moonIllumination}%)\n`;
        }
        if (airQuality) {
            weatherFactors.aqi = parseFloat(airQuality.aqi) || 50;
            factorsSummary += `- 空气质量: ${airQuality.category} (AQI: ${weatherFactors.aqi})\n`;
        }
        if (solarAngle) {
            weatherFactors.solarElevation = parseFloat(solarAngle.solarElevationAngle) || 0;
            factorsSummary += `- 太阳角度: 高度角 ${weatherFactors.solarElevation.toFixed(2)}°, 方位角 ${solarAngle.solarAzimuthAngle}°\n`;
        }
        if (warnings && warnings.length > 0) {
            weatherFactors.hasWarning = 1;
            const warningTitles = warnings.map(w => `${w.typeName}${w.level}预警`).join(', ');
            factorsSummary += `- 气象预警: ${warningTitles}\n`;
        }

    } catch (e) {
        factorsSummary += "- 天气/环境数据不可用，使用标准参数。\n";
    }

    // --- Celestial Factors (Astrological Influences) ---
    const celestialDBPath = path.join(__dirname, 'celestial_database.json');
    let celestialFactors = {};
    try {
        const celestialDBContent = await fs.readFile(celestialDBPath, 'utf-8');
        const celestialDatabase = JSON.parse(celestialDBContent);
        const nowUTC = new Date();

        let closestTimestampKey = null;
        let smallestDiff = Infinity;

        // Find the closest timestamp key from the database.
        for (const timestampKey in celestialDatabase) {
            const timestamp = new Date(timestampKey);
            const diff = Math.abs(nowUTC - timestamp);
            if (diff < smallestDiff) {
                smallestDiff = diff;
                closestTimestampKey = timestampKey;
            }
        }

        // The user mentioned a 2-hour interval, so we should be reasonably close.
        // Let's use a 3-hour threshold to be safe.
        if (closestTimestampKey && smallestDiff < 3 * 60 * 60 * 1000) {
            const celestialData = celestialDatabase[closestTimestampKey];
            celestialFactors = celestialData; // Store the raw data
            
            const dataTime = new Date(closestTimestampKey);
            factorsSummary += `- 天体位置 (数据采样于 ${dataTime.toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai' })}):\n`;
            
            const planetTranslations = {
                mercury: '水星', venus: '金星', earth: '地球', mars: '火星',
                jupiter: '木星', saturn: '土星', uranus: '天王星', neptune: '海王星'
            };

            let celestialDetails = [];
            for (const [planet, coords] of Object.entries(celestialData)) {
                // Describe position in a more "mystical" way
                // These are heliocentric ecliptic coordinates.
                // x/y are on the ecliptic plane, z is above/below.
                let x_desc = coords.x_au > 0 ? '太阳的“前方”' : '太阳的“后方”'; // Simplified direction relative to a zero-point
                let y_desc = coords.y_au > 0 ? '黄道的“左侧”' : '黄道的“右侧”'; // Simplified direction
                let z_desc = Math.abs(coords.z_au) < 0.05 ? '贴近黄道面' : (coords.z_au > 0 ? '升于黄道之上' : '潜于黄道之下');
                celestialDetails.push(`    - ${planetTranslations[planet] || planet}: ${z_desc}，位于${x_desc}与${y_desc}的象限`);
            }
            factorsSummary += celestialDetails.join('\n') + '\n';

        } else {
            factorsSummary += "- 天体位置数据不可用或与当前时间差距过大。\n";
        }

    } catch (e) {
        // If the file doesn't exist, it's not a critical error.
        if (e.code === 'ENOENT') {
            factorsSummary += "- 未找到天体数据库 (celestial_database.json)。\n";
        } else {
            factorsSummary += `- 读取天体数据库时出错: ${e.message}\n`;
        }
    }

    const allFactors = { ...timeFactors, ...lunarFactors, ...weatherFactors, ...celestialFactors };
    let seedString = JSON.stringify(allFactors);
    if (fateCheckNumber !== null && !isNaN(parseInt(fateCheckNumber))) {
        seedString += `::FATE_CHECK::${fateCheckNumber}`;
    }
    const seededRandom = createSeededRandom(seedString);

    return {
        random: seededRandom,
        summary: factorsSummary,
        factors: allFactors
    };
}


/**
 * Defines the inherent affinities of certain cards to environmental factors.
 * 'pos' means positive affinity (more likely), 'neg' means negative.
 */
function getCardAffinities() {
    // Added planetary affinities. The value is the planet's key in the celestial data.
    return {
        'The Sun': { time: 'day', weather: 'good' },
        'The Moon': { time: 'night', planet: 'neptune' }, // Neptune for illusion/dreams
        'The Star': { time: 'night', planet: 'uranus' }, // Uranus for innovation/revelation
        'The High Priestess': { moon: 'full' },
        'The Hermit': { time: 'night', planet: 'saturn' }, // Saturn for solitude/discipline
        'The Tower': { weather: 'bad', planet: 'mars' }, // Mars for conflict
        'Death': { weather: 'bad' },
        'The Devil': { weather: 'bad' },
        'Ten of Swords': { weather: 'bad' },
        'The Lovers': { festive: 'pos', planet: 'venus' }, // Venus for love/harmony
        'Four of Wands': { festive: 'pos' },
        'The World': { festive: 'pos' },
        'The Magician': { planet: 'mercury' }, // Mercury for communication/skill
        'The Chariot': { planet: 'mars' }, // Mars for drive/ambition
        'Wheel of Fortune': { planet: 'jupiter' }, // Jupiter for luck/expansion
        'The Emperor': { planet: 'jupiter' } // Jupiter for authority/leadership
    };
}

/**
 * Calculates drawing weights for each card based on affinities and factors.
 * @param {Array} deck The full deck of cards.
 * @param {object} factors The environmental factors.
 * @returns {Array} An array of cards, each with a calculated 'weight'.
 */
function calculateCardWeights(deck, factors) {
    const affinities = getCardAffinities();
    return deck.map(card => {
        let weight = 100; // Base weight
        const cardAffinities = affinities[card.name];

        if (cardAffinities) {
            // --- Standard Affinities ---
            if (cardAffinities.time === 'day' && factors.hour > 6 && factors.hour < 18) weight += 50;
            if (cardAffinities.time === 'night' && (factors.hour >= 18 || factors.hour <= 6)) weight += 50;
            if (cardAffinities.weather === 'good' && !factors.isRainOrSnow) weight += 40;
            if (cardAffinities.weather === 'bad' && factors.isRainOrSnow) weight += 60;
            if (cardAffinities.moon === 'full' && factors.moonIllumination > 95) weight += 50;
            if (cardAffinities.festive === 'pos' && factors.isFestive) weight += 70;

            // --- Celestial Affinities ---
            if (cardAffinities.planet && factors[cardAffinities.planet]) {
                const planetData = factors[cardAffinities.planet];
                // A planet's influence is stronger when it's further from the ecliptic plane (z_au).
                // This signifies it's in a more "pronounced" or "active" state.
                const z_influence = Math.abs(planetData.z_au || 0);
                // We give a bonus based on this deviation. The multiplier is arbitrary but creates effect.
                // e.g., z_au of 0.5 gives a 25 point bonus. z_au of 2.0 gives a 100 point bonus.
                const celestialBonus = z_influence * 50;
                weight += celestialBonus;
            }
        }
        
        // Ensure weight is at least a small number
        card.weight = Math.max(10, weight);
        return card;
    });
}

/**
 * Draws a specified number of cards from a deck using weighted random sampling without replacement.
 * @param {Array} weightedDeck The deck of cards, each with a 'weight' property.
 * @param {number} numToDraw The number of cards to draw.
 * @param {function(): number} random The seeded random number generator.
 * @returns {Array} An array of the drawn cards.
 */
function drawWeightedCards(weightedDeck, numToDraw, random) {
    const drawnCards = [];
    let deckCopy = [...weightedDeck];

    for (let i = 0; i < numToDraw; i++) {
        if (deckCopy.length === 0) break;

        const totalWeight = deckCopy.reduce((sum, card) => sum + card.weight, 0);
        let randomWeight = random() * totalWeight;
        
        let selectedCard = null;
        for (let j = 0; j < deckCopy.length; j++) {
            randomWeight -= deckCopy[j].weight;
            if (randomWeight <= 0) {
                selectedCard = deckCopy[j];
                deckCopy.splice(j, 1); // Remove the card from the pool
                break;
            }
        }
        
        // Fallback in case of floating point inaccuracies
        if (!selectedCard) {
            selectedCard = deckCopy.pop();
        }

        drawnCards.push(selectedCard);
    }
    return drawnCards;
}

/**
 * Calculates the dynamic probability of a card being reversed based on various factors.
 * @param {object} card The card object.
 * @param {object} factors The collected environmental and temporal factors.
 * @returns {number} A probability between 0.05 and 0.95.
 */
function calculateReversalProbability(card, factors) {
    let probability = 0.25; // Base probability of 25%

    // --- Celestial Instability Factor ---
    // Calculate a score based on how "out of alignment" the planets are.
    // We sum the absolute z_au values. A higher value means more planets are far
    // from the ecliptic plane, suggesting cosmic "tension" or "instability".
    let celestialInstabilityScore = 0;
    const planetKeys = ['mercury', 'venus', 'mars', 'jupiter', 'saturn', 'uranus', 'neptune'];
    for (const planetKey of planetKeys) {
        if (factors[planetKey]) {
            celestialInstabilityScore += Math.abs(factors[planetKey].z_au || 0);
        }
    }
    // Normalize this score into a probability adjustment.
    // The sum can vary. A typical sum might be around 2-5. A high sum could be 10+.
    // Let's say every point in the score adds 1.5% to the reversal probability.
    // This makes celestial influence significant but not overwhelming.
    probability += (celestialInstabilityScore * 0.015);


    // --- Environmental Factor Adjustments ---

    // Weather Warning: A major sign of instability.
    probability += factors.hasWarning * 0.20; // +20% if there's an active warning

    // Moon: New moon (0% illumination) increases chance, full moon (100%) decreases it.
    probability += (100 - factors.moonIllumination) / 100 * 0.10; // Max +10%

    // Sun Position: Sun below the horizon increases uncertainty.
    if (factors.solarElevation < 0) {
        probability += (Math.abs(factors.solarElevation) / 90) * 0.10; // Max +10% for sun being far below horizon
    }

    // Weather: Rain/snow, high humidity, and high wind increase chance
    probability += factors.isRainOrSnow * 0.10; // +10% if raining/snowing
    if (factors.humidity > 85) probability += 0.05; // +5% for high humidity
    if (factors.windSpeed > 30) probability += 0.05; // +5% for high wind speed (e.g., > 30 km/h)
    
    // Air Quality: Poor air quality adds to the negativity.
    if (factors.aqi > 150) { // "Unhealthy" or worse
        probability += 0.10;
    } else if (factors.aqi > 100) { // "Unhealthy for Sensitive Groups"
        probability += 0.05;
    }

    // Time: Late night hours increase chance
    if (factors.hour >= 23 || factors.hour <= 3) {
        probability += 0.10; // +10% for deep night
    }

    // Card-specific adjustments based on name hash (for subtle variety)
    let nameHash = 0;
    for (let i = 0; i < card.name.length; i++) {
        nameHash = (nameHash << 5) - nameHash + card.name.charCodeAt(i);
        nameHash |= 0; // Convert to 32bit integer
    }
    probability += (nameHash % 100) / 2000; // Add a smaller, consistent +/- 2.5% based on card name

    // Clamp the probability to be between 5% and 95%
    return Math.max(0.05, Math.min(0.95, probability));
}


/**
 * Loads the tarot deck data from the JSON file.
 * @returns {Promise<Array>} A promise that resolves to an array of all 78 card objects.
 */
async function loadDeck() {
    const deckPath = path.join(__dirname, 'tarot_deck.json');
    const deckContent = await fs.readFile(deckPath, 'utf-8');
    const deckData = JSON.parse(deckContent);
    const fullDeck = [
        ...deckData.major_arcana,
        ...deckData.minor_arcana.wands,
        ...deckData.minor_arcana.cups,
        ...deckData.minor_arcana.swords,
        ...deckData.minor_arcana.pentacles
    ];
    return fullDeck;
}

/**
 * Processes a single drawn card to get its details, including image data.
 * @param {object} card The card object from the deck.
 * @param {function(): number} random The random number generator function.
 * @param {object} divinationFactors The object containing all environmental factors.
 * @returns {Promise<object>} A promise that resolves to the processed card details.
 */
async function processDrawnCard(card, random, divinationFactors) {
    const reversalProbability = calculateReversalProbability(card, divinationFactors);
    const isReversed = random() < reversalProbability;
    const imageName = isReversed ? `逆位${card.image}` : card.image;
    const imagePath = path.join(PROJECT_BASE_PATH, 'image', 'tarotcards', imageName);

    let imageBase64 = '';
    let error = null;
    try {
        const imageBuffer = await fs.readFile(imagePath);
        imageBase64 = imageBuffer.toString('base64');
    } catch (e) {
        error = `Could not read image file: ${imageName}. Error: ${e.message}`;
        // Try to read the non-reversed image as a fallback
        try {
            const fallbackImagePath = path.join(PROJECT_BASE_PATH, 'image', 'tarotcards', card.image);
            const imageBuffer = await fs.readFile(fallbackImagePath);
            imageBase64 = imageBuffer.toString('base64');
            error += ` | Successfully used fallback image: ${card.image}`;
        } catch (fallbackError) {
             error += ` | Fallback image also failed: ${fallbackError.message}`;
        }
    }
    
    const relativeServerPathForUrl = path.join('tarotcards', imageName).replace(/\\/g, '/');
    const accessibleImageUrl = `${VAR_HTTP_URL}:${SERVER_PORT}/pw=${IMAGESERVER_IMAGE_KEY}/images/${relativeServerPathForUrl}`;
    const imageMimeType = `image/${path.extname(card.image).substring(1)}`;

    return {
        name: card.name,
        name_cn: card.name_cn,
        reversed: isReversed,
        reversal_probability: reversalProbability, // Include for transparency
        image_url: accessibleImageUrl,
        image_base64: imageBase64,
        mime_type: imageMimeType,
        error: error
    };
}


// --- Main Logic ---

async function handleRequest(args) {
    if (!PROJECT_BASE_PATH || !SERVER_PORT || !IMAGESERVER_IMAGE_KEY || !VAR_HTTP_URL) {
        throw new Error("One or more required environment variables (PROJECT_BASE_PATH, PORT, Image_Key, VarHttpUrl) are not set.");
    }

    const { command, fate_check_number = null } = args;

    // --- Command: Get Celestial Data ---
    if (command === 'get_celestial_data') {
        const { summary: factorsSummary, factors: divinationFactors } = await getDivinationFactors();
        
        let rawDataText = "### 原始天文及环境数据 ###\n";
        rawDataText += "#### 时间与农历 ####\n";
        rawDataText += `- 公历时间: ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}\n`;
        rawDataText += `- 农历: ${divinationFactors.ganzhiYear} ${divinationFactors.lunarMonthName}${divinationFactors.lunarDayName}\n`;
        rawDataText += `- 节气: ${divinationFactors.solarTerm}\n\n`;

        rawDataText += "#### 天文数据 ####\n";
        rawDataText += `- 太阳高度角: ${divinationFactors.solarElevation?.toFixed(4) || 'N/A'}\n`;
        rawDataText += `- 月相光照度: ${divinationFactors.moonIllumination?.toFixed(2) || 'N/A'}%\n`;
        
        const planetKeys = ['mercury', 'venus', 'earth', 'mars', 'jupiter', 'saturn', 'uranus', 'neptune'];
        rawDataText += "行星日心黄道坐标 (AU):\n";
        for (const pKey of planetKeys) {
            if (divinationFactors[pKey]) {
                const pData = divinationFactors[pKey];
                rawDataText += `- ${pKey.padEnd(8)}: X=${pData.x_au.toFixed(6)}, Y=${pData.y_au.toFixed(6)}, Z=${pData.z_au.toFixed(6)}\n`;
            }
        }
        rawDataText += "\n";

        rawDataText += "#### 环境数据 ####\n";
        rawDataText += `- 天气: ${divinationFactors.text || 'N/A'}, 温度: ${divinationFactors.temp}°C, 湿度: ${divinationFactors.humidity}%\n`;
        rawDataText += `- 风速: ${divinationFactors.windSpeed} km/h, 风向: ${divinationFactors.windDir}\n`;
        rawDataText += `- 空气质量指数 (AQI): ${divinationFactors.aqi}\n`;
        rawDataText += `- 气象预警: ${divinationFactors.hasWarning ? '是' : '否'}\n`;

        const fullReport = `**天相解读:**\n${factorsSummary}\n---\n\n**原始数据分析:**\n${rawDataText}`;

        return {
            status: "success",
            result: {
                // For pure text results, we can just return a string.
                content: fullReport
            }
        };
    }


    // --- Command: Draw Cards ---
    let cardsToDraw = 0;
    let spreadName = "";
    let positions = [];

    switch (command) {
        case 'draw_single_card':
            cardsToDraw = 1;
            spreadName = "单牌占卜";
            positions = ["结果"];
            break;
        case 'draw_three_card_spread':
            cardsToDraw = 3;
            spreadName = "三牌阵";
            positions = ["过去", "现在", "未来"];
            break;
        case 'draw_celtic_cross':
            cardsToDraw = 10;
            spreadName = "凯尔特十字牌阵";
            positions = [
                "1. 现状", "2. 阻碍", "3. 目标", "4. 根基",
                "5. 过去", "6. 未来", "7. 自我认知", "8. 环境影响",
                "9. 希望与恐惧", "10. 最终结果"
            ];
            break;
        default:
            throw new Error(`Unknown command: ${command}`);
    }

    // 2. Get divination factors and the seeded random generator
    const { random, summary: factorsSummary, factors: divinationFactors } = await getDivinationFactors(fate_check_number);

    // 3. Load the deck and calculate weights
    const deck = await loadDeck();
    if (deck.length < cardsToDraw) {
        throw new Error("Not enough cards in the deck to perform this spread.");
    }
    const weightedDeck = calculateCardWeights(deck, divinationFactors);

    // 4. Draw cards using the weighted sampling algorithm
    const drawnCardsRaw = drawWeightedCards(weightedDeck, cardsToDraw, random);

    // 5. Process each drawn card (determine reversal, get image, etc.)
    const processedCardsPromises = drawnCardsRaw.map(card => processDrawnCard(card, random, divinationFactors));
    const processedCards = await Promise.all(processedCardsPromises);

    // 6. Build the final response content
    let summaryText = `**${spreadName} - 占卜结果**\n\n`;
    summaryText += `${factorsSummary}\n---\n\n`;
    const contentForAI = [];
    const imageContents = [];

    processedCards.forEach((pCard, index) => {
        const position = positions[index] || `卡牌 ${index + 1}`;
        const probPercent = (pCard.reversal_probability * 100).toFixed(0);
        const reversedText = pCard.reversed ? ` (逆位, 倾向 ${probPercent}%)` : ` (正位, 逆位倾向 ${probPercent}%)`;
        summaryText += `**${position}: ${pCard.name_cn}${reversedText}**\n`;

        if (pCard.image_base64) {
            imageContents.push({
                type: 'image_url',
                image_url: {
                    url: `data:${pCard.mime_type};base64,${pCard.image_base64}`
                }
            });
            summaryText += `图片链接: ${pCard.image_url}\n`;
        }
        if (pCard.error) {
            summaryText += `图片加载错误: ${pCard.error}\n`;
        }
        summaryText += '\n';
    });

    contentForAI.push({ type: 'text', text: summaryText.trim() });
    contentForAI.push(...imageContents);

    return {
        status: "success",
        result: {
            content: contentForAI,
            details: processedCards.map((pCard, index) => ({
                position: positions[index] || `Card ${index + 1}`,
                ...pCard
            }))
        }
    };
}


async function main() {
    let inputChunks = [];
    process.stdin.setEncoding('utf8');

    for await (const chunk of process.stdin) {
        inputChunks.push(chunk);
    }
    const inputData = inputChunks.join('');
    let parsedArgs;

    try {
        if (!inputData.trim()) {
            throw new Error("No input data received from stdin.");
        }
        parsedArgs = JSON.parse(inputData);
        const resultObject = await handleRequest(parsedArgs);
        console.log(JSON.stringify(resultObject));
    } catch (e) {
        console.log(JSON.stringify({ status: "error", error: `TarotDivination Plugin Error: ${e.message}` }));
        process.exit(1);
    }
}

main();