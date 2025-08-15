#!/usr/bin/env node

const fs = require('fs').promises;
const path = require('path');
const lunarCalendar = require('chinese-lunar-calendar');

// --- Configuration (from environment variables set by Plugin.js) ---
const PROJECT_BASE_PATH = process.env.PROJECT_BASE_PATH;
const SERVER_PORT = process.env.PORT;
const IMAGESERVER_IMAGE_KEY = process.env.Image_Key;
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
 * Determines the Origin based on user input, with a small chance of Void manifestation.
 * @param {string} inputOrigin The user-provided origin string
 * @param {function} random The random generator
 * @returns {object} Origin object with type and description
 */
function determineOrigin(inputOrigin, random) {
    const VOID_PROBABILITY = 0.0333; // 3.33% chance - a mystical number
    
    // Check for Void manifestation first
    if (random() < VOID_PROBABILITY) {
        return {
            type: 'void',
            name: '虚',
            description: '起源进入了虚无状态，天体的光踪隐入未知，命运的织线变得混沌而不可预测',
            symbol: '◯'
        };
    }
    
    // Normalize input
    const normalizedInput = inputOrigin ? inputOrigin.toLowerCase().trim() : '';
    
    const originMap = {
        '日': 'sun', 'sun': 'sun', '太阳': 'sun',
        '月': 'moon', 'moon': 'moon', '月亮': 'moon',
        '星': 'star', 'star': 'star', '星辰': 'star'
    };
    
    const originType = originMap[normalizedInput] || 'star'; // Default to star if unrecognized
    
    const origins = {
        'sun': {
            type: 'sun',
            name: '日',
            description: '太阳起源 - 意志与行动的显现，白昼的主宰',
            symbol: '☉'
        },
        'moon': {
            type: 'moon',
            name: '月',
            description: '月亮起源 - 直觉与潜意识的涌动，夜晚的守护',
            symbol: '☽'
        },
        'star': {
            type: 'star',
            name: '星',
            description: '星辰起源 - 希望与指引的光芒，宇宙的平衡',
            symbol: '✦'
        }
    };
    
    return origins[originType];
}

/**
 * Calculates origin-specific modifiers for celestial influences.
 * @param {string} originType The type of origin
 * @param {object} celestialFactors The celestial position data
 * @returns {object} Modified weights for different influences
 */
function calculateOriginCelestialModifiers(originType, celestialFactors) {
    const modifiers = {
        planetaryInfluence: {},
        generalMultiplier: 1.0,
        reversalAdjustment: 0
    };
    
    switch(originType) {
        case 'sun':
            // Sun origin: Mars and Jupiter amplified, Neptune and Moon dampened
            modifiers.planetaryInfluence = {
                mars: 2.5,      // Action and courage magnified
                jupiter: 2.0,    // Expansion and leadership enhanced
                mercury: 1.5,    // Communication clarified
                venus: 1.2,      // Harmony appreciated
                saturn: 0.8,     // Restrictions lessened
                neptune: 0.3,    // Illusions dispersed
                uranus: 1.0      // Innovation neutral
            };
            modifiers.generalMultiplier = 1.3;
            modifiers.reversalAdjustment = -0.15; // Less likely to reverse in solar clarity
            break;
            
        case 'moon':
            // Moon origin: Neptune and inner planets amplified
            modifiers.planetaryInfluence = {
                neptune: 3.0,    // Dreams and intuition maximized
                venus: 2.0,      // Emotions intensified
                mercury: 0.7,    // Logic clouded
                mars: 0.5,       // Action subdued
                jupiter: 1.2,    // Wisdom through feeling
                saturn: 1.5,     // Deep introspection
                uranus: 1.8      // Sudden insights
            };
            modifiers.generalMultiplier = 1.5;
            modifiers.reversalAdjustment = 0.25; // More likely to see shadows
            break;
            
        case 'star':
            // Star origin: Outer planets and balance emphasized
            modifiers.planetaryInfluence = {
                uranus: 2.5,     // Revolutionary insight
                neptune: 2.0,    // Spiritual connection
                jupiter: 1.8,    // Cosmic wisdom
                saturn: 1.5,     // Karmic lessons
                mars: 1.0,       // Balanced action
                venus: 1.0,      // Balanced emotion
                mercury: 1.3     // Higher communication
            };
            modifiers.generalMultiplier = 1.4;
            modifiers.reversalAdjustment = 0; // Perfect balance
            break;
            
        case 'void':
            // Void origin: Chaotic and inverted influences
            const voidRandom = Math.sin(Date.now()) * 10000;
            const voidFactor = (voidRandom - Math.floor(voidRandom));
            modifiers.planetaryInfluence = {
                mars: 0.1 + voidFactor * 4,      // Wildly variable
                jupiter: 3 - voidFactor * 2.5,    // Inverted luck
                mercury: voidFactor < 0.5 ? 0.1 : 5.0, // Binary extremes
                venus: 2 * Math.sin(voidFactor * Math.PI), // Oscillating
                saturn: voidFactor * voidFactor * 4, // Exponential
                neptune: 1 / (voidFactor + 0.1),  // Inverse proportion
                uranus: Math.abs(Math.cos(voidFactor * Math.PI * 2)) * 3 // Pulsing
            };
            modifiers.generalMultiplier = 0.5 + voidFactor * 2; // 0.5 to 2.5
            modifiers.reversalAdjustment = voidFactor - 0.5; // -0.5 to +0.5
            break;
    }
    
    return modifiers;
}

/**
 * Gathers various environmental and temporal factors to create a unique seed for divination.
 * @returns {Promise<object>} A promise that resolves to an object containing the random generator, a summary of factors, and the factors themselves.
 */
async function getDivinationFactors(fateCheckNumber = null, originInput = null) {
    const weatherCachePath = path.join(PROJECT_BASE_PATH, 'Plugin', 'WeatherReporter', 'weather_cache.json');
    let weatherData = {};
    let factorsSummary = "占卜因素：\n";
    const now = new Date();
    
    // Create initial random for origin determination
    const preliminaryRandom = createSeededRandom(now.toISOString());
    
    // --- Origin Determination ---
    const origin = determineOrigin(originInput, preliminaryRandom);
    factorsSummary += `- 起源: ${origin.symbol} ${origin.name} - ${origin.description}\n`;

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

        for (const timestampKey in celestialDatabase) {
            const timestamp = new Date(timestampKey);
            const diff = Math.abs(nowUTC - timestamp);
            if (diff < smallestDiff) {
                smallestDiff = diff;
                closestTimestampKey = timestampKey;
            }
        }

        if (closestTimestampKey && smallestDiff < 3 * 60 * 60 * 1000) {
            const celestialData = celestialDatabase[closestTimestampKey];
            celestialFactors = celestialData;
            
            const dataTime = new Date(closestTimestampKey);
            factorsSummary += `- 天体位置 (数据采样于 ${dataTime.toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai' })}):\n`;
            
            const planetTranslations = {
                mercury: '水星', venus: '金星', earth: '地球', mars: '火星',
                jupiter: '木星', saturn: '土星', uranus: '天王星', neptune: '海王星'
            };

            // Apply origin-specific descriptions
            let celestialDetails = [];
            const originModifiers = calculateOriginCelestialModifiers(origin.type, celestialFactors);
            
            for (const [planet, coords] of Object.entries(celestialData)) {
                const influence = originModifiers.planetaryInfluence[planet] || 1.0;
                const influenceDesc = influence > 1.5 ? ' [强化影响]' : influence < 0.7 ? ' [减弱影响]' : '';
                
                let x_desc = coords.x_au > 0 ? '太阳的"前方"' : '太阳的"后方"';
                let y_desc = coords.y_au > 0 ? '黄道的"左侧"' : '黄道的"右侧"';
                let z_desc = Math.abs(coords.z_au) < 0.05 ? '贴近黄道面' : (coords.z_au > 0 ? '升于黄道之上' : '潜于黄道之下');
                celestialDetails.push(`    - ${planetTranslations[planet] || planet}: ${z_desc}，位于${x_desc}与${y_desc}的象限${influenceDesc}`);
            }
            factorsSummary += celestialDetails.join('\n') + '\n';

        } else {
            factorsSummary += "- 天体位置数据不可用或与当前时间差距过大。\n";
        }

    } catch (e) {
        if (e.code === 'ENOENT') {
            factorsSummary += "- 未找到天体数据库 (celestial_database.json)。\n";
        } else {
            factorsSummary += `- 读取天体数据库时出错: ${e.message}\n`;
        }
    }

    const allFactors = { 
        ...timeFactors, 
        ...lunarFactors, 
        ...weatherFactors, 
        ...celestialFactors,
        origin: origin.type
    };
    
    let seedString = JSON.stringify(allFactors);
    if (fateCheckNumber !== null && !isNaN(parseInt(fateCheckNumber))) {
        seedString += `::FATE_CHECK::${fateCheckNumber}`;
    }
    seedString += `::ORIGIN::${origin.type}`;
    
    const seededRandom = createSeededRandom(seedString);

    return {
        random: seededRandom,
        summary: factorsSummary,
        factors: allFactors,
        origin: origin
    };
}

/**
 * Defines the inherent affinities of certain cards to environmental factors and origins.
 */
function getCardAffinities() {
    return {
        // Major Arcana
        'The Sun': { 
            time: 'day', weather: 'good', origin: 'sun',
            elements: ['fire'], planet: 'sun'
        },
        'The Moon': { 
            time: 'night', moon: 'full', origin: 'moon',
            elements: ['water'], planet: 'neptune'
        },
        'The Star': { 
            time: 'night', origin: 'star',
            elements: ['air'], planet: 'uranus'
        },
        'The High Priestess': { 
            moon: 'full', origin: 'moon',
            elements: ['water'], planet: 'moon'
        },
        'The Hermit': { 
            time: 'night', origin: 'star',
            elements: ['earth'], planet: 'saturn'
        },
        'The Tower': { 
            weather: 'bad', origin: 'void',
            elements: ['fire'], planet: 'mars'
        },
        'Death': { 
            weather: 'bad', origin: 'void',
            elements: ['water'], planet: 'pluto'
        },
        'The Devil': { 
            weather: 'bad', origin: 'void',
            elements: ['earth'], planet: 'saturn'
        },
        'The Fool': {
            origin: 'void',
            elements: ['air'], planet: 'uranus'
        },
        'The Magician': { 
            origin: 'sun',
            elements: ['air', 'fire'], planet: 'mercury'
        },
        'The Empress': {
            origin: 'moon',
            elements: ['earth'], planet: 'venus'
        },
        'The Emperor': {
            origin: 'sun',
            elements: ['fire'], planet: 'mars'
        },
        'The Chariot': { 
            origin: 'sun',
            elements: ['water'], planet: 'mars'
        },
        'Wheel of Fortune': { 
            origin: 'star',
            elements: ['fire'], planet: 'jupiter'
        },
        'Justice': {
            origin: 'star',
            elements: ['air'], planet: 'venus'
        },
        'Temperance': {
            origin: 'star',
            elements: ['fire'], planet: 'jupiter'
        },
        'The World': { 
            festive: 'pos', origin: 'star',
            elements: ['earth'], planet: 'saturn'
        },
        'The Lovers': { 
            festive: 'pos', origin: 'moon',
            elements: ['air'], planet: 'venus'
        },
        'Strength': {
            origin: 'sun',
            elements: ['fire'], planet: 'sun'
        },
        'The Hanged Man': {
            origin: 'void',
            elements: ['water'], planet: 'neptune'
        },
        'Judgement': {
            origin: 'star',
            elements: ['fire'], planet: 'pluto'
        },
        
        // Minor Arcana special cards
        'Ten of Swords': { 
            weather: 'bad', origin: 'void',
            elements: ['air']
        },
        'Four of Wands': { 
            festive: 'pos', origin: 'sun',
            elements: ['fire']
        },
        'Three of Swords': {
            weather: 'bad', origin: 'moon',
            elements: ['air']
        },
        'Nine of Cups': {
            festive: 'pos', origin: 'sun',
            elements: ['water']
        },
        'Five of Pentacles': {
            weather: 'bad', origin: 'void',
            elements: ['earth']
        }
    };
}

/**
 * Calculates drawing weights for each card based on affinities, factors, and origin.
 */
function calculateCardWeights(deck, factors, origin) {
    const affinities = getCardAffinities();
    const originModifiers = calculateOriginCelestialModifiers(origin.type, factors);
    
    return deck.map(card => {
        let weight = 100; // Base weight
        const cardAffinities = affinities[card.name];
        
        // --- Origin-specific base weight adjustments ---
        switch(origin.type) {
            case 'sun':
                // Sun origin favors Wands and day-associated cards
                if (card.suit === 'wands') weight += 40;
                if (card.suit === 'swords') weight += 20;
                if (card.suit === 'cups') weight -= 20;
                break;
            case 'moon':
                // Moon origin favors Cups and night-associated cards
                if (card.suit === 'cups') weight += 40;
                if (card.suit === 'pentacles') weight += 20;
                if (card.suit === 'wands') weight -= 20;
                break;
            case 'star':
                // Star origin favors Swords and balanced distribution
                if (card.suit === 'swords') weight += 30;
                if (card.suit === 'major') weight += 25; // Major arcana more likely
                break;
            case 'void':
                // Void origin creates chaos
                const voidHash = card.name.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
                weight = 50 + (voidHash % 200); // Random range 50-250
                break;
        }

        if (cardAffinities) {
            // --- Origin affinity ---
            if (cardAffinities.origin === origin.type) {
                weight += 100; // Strong affinity to matching origin
            } else if (cardAffinities.origin === 'void' && origin.type !== 'void') {
                weight -= 30; // Void cards less likely in ordered origins
            }
            
            // --- Standard Affinities (modified by origin) ---
            if (cardAffinities.time === 'day' && factors.hour > 6 && factors.hour < 18) {
                const modifier = origin.type === 'sun' ? 2.0 : origin.type === 'moon' ? 0.5 : 1.0;
                weight += 50 * modifier;
            }
            if (cardAffinities.time === 'night' && (factors.hour >= 18 || factors.hour <= 6)) {
                const modifier = origin.type === 'moon' ? 2.0 : origin.type === 'sun' ? 0.5 : 1.0;
                weight += 50 * modifier;
            }
            
            if (cardAffinities.weather === 'good' && !factors.isRainOrSnow) {
                const modifier = origin.type === 'sun' ? 1.5 : 1.0;
                weight += 40 * modifier;
            }
            if (cardAffinities.weather === 'bad' && factors.isRainOrSnow) {
                const modifier = origin.type === 'void' ? 2.0 : origin.type === 'moon' ? 1.5 : 1.0;
                weight += 60 * modifier;
            }
            
            if (cardAffinities.moon === 'full' && factors.moonIllumination > 95) {
                const modifier = origin.type === 'moon' ? 3.0 : 1.0;
                weight += 50 * modifier;
            }
            
            if (cardAffinities.festive === 'pos' && factors.isFestive) {
                const modifier = origin.type === 'sun' ? 1.5 : 1.0;
                weight += 70 * modifier;
            }

            // --- Celestial Affinities (modified by origin) ---
            if (cardAffinities.planet && factors[cardAffinities.planet]) {
                const planetData = factors[cardAffinities.planet];
                const z_influence = Math.abs(planetData.z_au || 0);
                const planetModifier = originModifiers.planetaryInfluence[cardAffinities.planet] || 1.0;
                const celestialBonus = z_influence * 50 * planetModifier;
                weight += celestialBonus;
            }
            
            // --- Elemental affinities based on origin ---
            if (cardAffinities.elements) {
                const elementWeights = {
                    'sun': { fire: 2.0, air: 1.5, water: 0.7, earth: 1.0 },
                    'moon': { water: 2.0, earth: 1.5, fire: 0.7, air: 1.0 },
                    'star': { air: 2.0, fire: 1.3, water: 1.3, earth: 1.0 },
                    'void': { fire: Math.random() * 2, water: Math.random() * 2, 
                             air: Math.random() * 2, earth: Math.random() * 2 }
                };
                
                const originElements = elementWeights[origin.type];
                cardAffinities.elements.forEach(element => {
                    weight *= (originElements[element] || 1.0);
                });
            }
        }
        
        // Apply general origin multiplier
        weight *= originModifiers.generalMultiplier;
        
        // Ensure weight is at least a small number
        card.weight = Math.max(10, Math.floor(weight));
        return card;
    });
}

/**
 * Draws a specified number of cards from a deck using weighted random sampling without replacement.
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
                deckCopy.splice(j, 1);
                break;
            }
        }
        
        if (!selectedCard) {
            selectedCard = deckCopy.pop();
        }

        drawnCards.push(selectedCard);
    }
    return drawnCards;
}

/**
 * Calculates the dynamic probability of a card being reversed based on various factors and origin.
 */
function calculateReversalProbability(card, factors, origin) {
    let probability = 0.22; // Base probability of 22%
    
    // Apply origin reversal adjustment
    const originModifiers = calculateOriginCelestialModifiers(origin.type, factors);
    probability += originModifiers.reversalAdjustment;

    // --- Origin-specific reversal patterns ---
    switch(origin.type) {
        case 'sun':
            // 太阳起源：逆位率与太阳高度角相关。
            // solarElevation > 0 (白天), < 0 (夜晚)
            if (factors.solarElevation > 0) {
                // 白天：太阳越高，逆位率越低
                // 太阳在最高点 (90度) 时，减少量最大
                let reduction = (factors.solarElevation / 90) * 0.20; // Max reduction of 0.20
                probability -= reduction;
                 // 正午时分 (角度 > 45)，额外显著降低
                if (factors.solarElevation > 45) {
                    probability -= 0.10;
                }
            } else {
                // 夜晚：选择太阳，逆位率上升
                // 太阳在最低点 (-90度) 时，增加量最大
                let increase = (Math.abs(factors.solarElevation) / 90) * 0.15; // Max increase of 0.15
                probability += increase;
            }
            // 晴朗天气进一步降低逆位率
            if (!factors.isRainOrSnow && factors.cloud < 30) {
                probability -= 0.05;
            }
            break;
            
        case 'moon':
            // 月亮起源：夜晚逆位率下降，白天上升；月相影响巨大
            // 日夜影响
            if (factors.solarElevation < 0) { // Night
                probability -= 0.05; // 夜晚略微下降
            } else { // Day
                probability += 0.05; // 白天略微上升
            }

            // 月相影响: 满月大幅下降，新月小幅下降
            // moonIllumination: 100 for full, 0 for new
            const moonPhaseModifier = -0.05 - (factors.moonIllumination / 100) * 0.15; // -0.05 (new) to -0.20 (full)
            probability += moonPhaseModifier;

            // 情绪化的天气（如下雨）会增加逆位率
            if (factors.isRainOrSnow) {
                probability += 0.08;
            }
            break;
            
        case 'star':
            // 星辰起源：与晨昏线相关
            // solarElevation 在 -18 到 0 度之间为晨昏蒙影时段
            if (factors.solarElevation > -18 && factors.solarElevation < 0) {
                if (factors.hour > 12) { // 傍晚 (Dusk)
                    probability -= 0.10; // 星星出现，逆位率下降
                } else { // 黎明 (Dawn)
                    probability += 0.10; // 星星隐退，逆位率上升
                }
            }
            
            // 保留原有的天体不稳定性和节气影响
            let outerPlanetInstability = 0;
            ['uranus', 'neptune', 'saturn'].forEach(planet => {
                if (factors[planet]) {
                    outerPlanetInstability += Math.abs(factors[planet].z_au || 0);
                }
            });
            probability += outerPlanetInstability * 0.03;
            if (factors.solarTerm && factors.solarTerm !== '无') {
                probability += 0.05;
            }
            break;
            
        case 'void':
            // Void creates extreme and unpredictable reversals
            const voidSeed = card.name.length * factors.hour * factors.minute;
            const voidChaos = Math.sin(voidSeed) * Math.cos(voidSeed * 0.7);
            probability = 0.5 + voidChaos * 0.45; // Range: 0.05 to 0.95
            break;
    }

    // --- Celestial Instability Factor ---
    let celestialInstabilityScore = 0;
    const planetKeys = ['mercury', 'venus', 'mars', 'jupiter', 'saturn', 'uranus', 'neptune'];
    for (const planetKey of planetKeys) {
        if (factors[planetKey]) {
            const planetModifier = originModifiers.planetaryInfluence[planetKey] || 1.0;
            celestialInstabilityScore += Math.abs(factors[planetKey].z_au || 0) * planetModifier;
        }
    }
    probability += (celestialInstabilityScore * 0.01);

    // --- Environmental Factor Adjustments ---
    probability += factors.hasWarning * 0.12;
    
    probability += factors.isRainOrSnow * 0.05;
    if (factors.humidity > 85) probability += 0.05;
    if (factors.windSpeed > 30) probability += 0.05;
    
    if (factors.aqi > 150) {
        probability += 0.05;
    } else if (factors.aqi > 100) {
        probability += 0.03;
    }
    
    if (factors.hour >= 23 || factors.hour <= 3) {
        probability += 0.03;
    }

    // Card-specific adjustments
    let nameHash = 0;
    for (let i = 0; i < card.name.length; i++) {
        nameHash = (nameHash << 5) - nameHash + card.name.charCodeAt(i);
        nameHash |= 0;
    }
    probability += (nameHash % 100) / 2000;

    // Clamp probability
    return Math.max(0.05, Math.min(0.95, probability));
}

/**
 * Loads the tarot deck data from the JSON file.
 */
async function loadDeck() {
    const deckPath = path.join(__dirname, 'tarot_deck.json');
    const deckContent = await fs.readFile(deckPath, 'utf-8');
    const deckData = JSON.parse(deckContent);
    
    // Add suit information to each card
    const fullDeck = [
        ...deckData.major_arcana.map(card => ({ ...card, suit: 'major' })),
        ...deckData.minor_arcana.wands.map(card => ({ ...card, suit: 'wands' })),
        ...deckData.minor_arcana.cups.map(card => ({ ...card, suit: 'cups' })),
        ...deckData.minor_arcana.swords.map(card => ({ ...card, suit: 'swords' })),
        ...deckData.minor_arcana.pentacles.map(card => ({ ...card, suit: 'pentacles' }))
    ];
    return fullDeck;
}

/**
 * Processes a single drawn card to get its details, including image data.
 */
async function processDrawnCard(card, random, divinationFactors, origin) {
    const reversalProbability = calculateReversalProbability(card, divinationFactors, origin);
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
        suit: card.suit,
        reversed: isReversed,
        reversal_probability: reversalProbability,
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

    const { command, fate_check_number = null, origin = null } = args;

    // --- Command: Get Celestial Data ---
    if (command === 'get_celestial_data') {
        const { summary: factorsSummary, factors: divinationFactors, origin: originData } = await getDivinationFactors(null, origin);
        
        let rawDataText = "### 原始天文及环境数据 ###\n";
        rawDataText += `\n#### 起源状态 ####\n`;
        rawDataText += `- ${originData.symbol} ${originData.name}: ${originData.description}\n\n`;
        
        rawDataText += "#### 时间与农历 ####\n";
        rawDataText += `- 公历时间: ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}\n`;
        rawDataText += `- 农历: ${divinationFactors.ganzhiYear} ${divinationFactors.lunarMonthName}${divinationFactors.lunarDayName}\n`;
        rawDataText += `- 节气: ${divinationFactors.solarTerm}\n\n`;

        rawDataText += "#### 天文数据 ####\n";
        rawDataText += `- 太阳高度角: ${divinationFactors.solarElevation?.toFixed(4) || 'N/A'}\n`;
        rawDataText += `- 月相光照度: ${divinationFactors.moonIllumination?.toFixed(2) || 'N/A'}%\n`;
        
        const planetKeys = ['mercury', 'venus', 'earth', 'mars', 'jupiter', 'saturn', 'uranus', 'neptune'];
        const originModifiers = calculateOriginCelestialModifiers(originData.type, divinationFactors);
        
        rawDataText += "行星日心黄道坐标 (AU) [起源影响系数]:\n";
        for (const pKey of planetKeys) {
            if (divinationFactors[pKey]) {
                const pData = divinationFactors[pKey];
                const modifier = originModifiers.planetaryInfluence[pKey] || 1.0;
                rawDataText += `- ${pKey.padEnd(8)}: X=${pData.x_au.toFixed(6)}, Y=${pData.y_au.toFixed(6)}, Z=${pData.z_au.toFixed(6)} [×${modifier.toFixed(2)}]\n`;
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

    // Get divination factors and the seeded random generator
    const { random, summary: factorsSummary, factors: divinationFactors, origin: originData } = 
        await getDivinationFactors(fate_check_number, origin);

    // Load the deck and calculate weights
    const deck = await loadDeck();
    if (deck.length < cardsToDraw) {
        throw new Error("Not enough cards in the deck to perform this spread.");
    }
    const weightedDeck = calculateCardWeights(deck, divinationFactors, originData);

    // Draw cards using the weighted sampling algorithm
    const drawnCardsRaw = drawWeightedCards(weightedDeck, cardsToDraw, random);

    // Process each drawn card
    const processedCardsPromises = drawnCardsRaw.map(card => 
        processDrawnCard(card, random, divinationFactors, originData)
    );
    const processedCards = await Promise.all(processedCardsPromises);

    // Build the final response content
    let summaryText = `**${spreadName} - 占卜结果**\n`;
    summaryText += `**起源: ${originData.symbol} ${originData.name}**\n\n`;
    summaryText += `${factorsSummary}\n---\n\n`;
    const contentForAI = [];
    const imageContents = [];

    processedCards.forEach((pCard, index) => {
        const position = positions[index] || `卡牌 ${index + 1}`;
        const probPercent = (pCard.reversal_probability * 100).toFixed(0);
        const reversedText = pCard.reversed ? ` (逆位, 倾向 ${probPercent}%)` : ` (正位, 逆位倾向 ${probPercent}%)`;
        const suitText = pCard.suit === 'major' ? ' [大阿卡纳]' : ` [${pCard.suit}]`;
        summaryText += `**${position}: ${pCard.name_cn}${reversedText}${suitText}**\n`;

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

    // Add card back URL for AI
    const cardBackImageName = '牌背.jpeg';
    const cardBackRelativePath = 'tarotcards/' + encodeURIComponent(cardBackImageName);
    const cardBackUrl = `${VAR_HTTP_URL}:${SERVER_PORT}/pw=${IMAGESERVER_IMAGE_KEY}/images/${cardBackRelativePath}`;
    contentForAI.push({ type: 'text', text: `牌背图片URL: ${cardBackUrl}` });
    
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
