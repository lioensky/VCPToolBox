'use strict';
var __importDefault =
  (this && this.__importDefault) ||
  function (mod) {
    return mod && mod.__esModule ? mod : { default: mod };
  };
Object.defineProperty(exports, '__esModule', { value: true });
exports.getCurrentDateTime = exports.getTime = void 0;
const dayjs_1 = __importDefault(require('dayjs'));
const DEFAULT_TIMEZONE = process.env.DEFAULT_TIMEZONE || 'Asia/Shanghai';
const dayjs_plugin_utc = require('dayjs/plugin/utc');
const dayjs_plugin_timezone = require('dayjs/plugin/timezone');
dayjs_1.default.extend(dayjs_plugin_utc);
dayjs_1.default.extend(dayjs_plugin_timezone);
/**
 * 将时间字符串或数字转换为时间戳
 * @param timeInput 时间字符串或数字
 * @returns 时间戳
 */
const getTime = timeInput => {
  try {
    let num;
    // 处理字符串的情况
    if (typeof timeInput === 'string') {
      // 尝试将字符串直接转换为数字
      num = Number(timeInput);
      if (isNaN(num)) {
        const now = (0, dayjs_1.default)().tz(DEFAULT_TIMEZONE);
        // 处理 "00:00"
        if (/^\d{2}:\d{2}$/.test(timeInput)) {
          const [hour, minute] = timeInput.split(':').map(Number);
          return now.set('hour', hour).set('minute', minute).set('second', 0).valueOf();
        }
        // 处理 昨天的时间
        if (/^昨日\s+\d{2}:\d{2}$/.test(timeInput)) {
          const timeStr = timeInput.replace('昨日', '').trim();
          const [hour, minute] = timeStr.split(':').map(Number);
          return now.subtract(1, 'day').set('hour', hour).set('minute', minute).set('second', 0).valueOf();
        }
        // 处理 今年的日期
        if (/^\d{1,2}月\d{1,2}日$/.test(timeInput)) {
          const [month, day] = timeInput.replace('月', '-').replace('日', '').split('-').map(Number);
          return now
            .set('month', month - 1)
            .set('date', day)
            .startOf('day')
            .valueOf();
        }
        // 处理 今年的日期+时间
        if (/^\d{1,2}月\d{1,2}日\s+\d{2}:\d{2}$/.test(timeInput)) {
          const [datePart, timePart] = timeInput.split(' ');
          const [month, day] = datePart.replace('月', '-').replace('日', '').split('-').map(Number);
          const [hour, minute] = timePart.split(':').map(Number);
          return now
            .set('month', month - 1)
            .set('date', day)
            .set('hour', hour)
            .set('minute', minute)
            .set('second', 0)
            .valueOf();
        }
        // 处理相对时间
        if (/今天/.test(timeInput)) {
          const timeStr = timeInput.replace('今天', '').trim();
          return (0, dayjs_1.default)()
            .tz(DEFAULT_TIMEZONE)
            .set('hour', parseInt(timeStr.split(':')[0]))
            .set('minute', parseInt(timeStr.split(':')[1]))
            .valueOf();
        }
        if (/昨天/.test(timeInput)) {
          const timeStr = timeInput.replace('昨天', '').trim();
          return (0, dayjs_1.default)()
            .tz(DEFAULT_TIMEZONE)
            .subtract(1, 'day')
            .set('hour', parseInt(timeStr.split(':')[0]))
            .set('minute', parseInt(timeStr.split(':')[1]))
            .valueOf();
        }
        if (/分钟前/.test(timeInput)) {
          const minutesAgo = parseInt(timeInput.replace('分钟前', ''));
          return (0, dayjs_1.default)().tz(DEFAULT_TIMEZONE).subtract(minutesAgo, 'minute').valueOf();
        }
        // 处理为标准格式
        let standardizedInput = timeInput
          .replace(/(\d{4})-(\d{2})-(\d{2})-(\d{2})/, '$1-$2-$3 $4') // "YYYY-MM-DD-HH" -> "YYYY-MM-DD HH"
          .replace(/(\d{4})-(\d{2})-(\d{2})[T\s](\d{2}):?(\d{2})?:?(\d{2})?/, '$1-$2-$3 $4:$5:$6') // "YYYY-MM-DDTHH:mm:ss" -> "YYYY-MM-DD HH:mm:ss"
          .replace(/(\d{4})[-/](\d{2})[-/](\d{2})/, '$1-$2-$3'); // "YYYY/MM/DD" or "YYYY-MM-DD" -> "YYYY-MM-DD"
        // 减少解析过程中可能的多余空格
        standardizedInput = standardizedInput.replace(/\s+/, ' ').trim();
        // 处理标准化后的日期时间字符串
        const formatPatterns = ['YYYY-MM-DD HH:mm:ss', 'YYYY-MM-DD HH:mm', 'YYYY-MM-DD HH', 'YYYY-MM-DD'];
        let parsedDate = undefined;
        for (const pattern of formatPatterns) {
          parsedDate = (0, dayjs_1.default)(standardizedInput, pattern, true).tz(DEFAULT_TIMEZONE);
          if (parsedDate.isValid()) {
            break;
          }
        }
        if (parsedDate && parsedDate.isValid()) {
          return parsedDate.valueOf();
        } else {
          return 0;
        }
      }
    } else {
      num = timeInput;
    }
    // 是否为毫秒级时间戳
    if (num > 946684800000) {
      // 以2000年作为毫秒时间戳参考点
      return num;
    } else {
      return num * 1000;
    }
  } catch (error) {
    console.error(error);
  }
};
exports.getTime = getTime;
/**
 * 获取当前日期时间
 * @param padZero 是否补零
 * @returns 当前日期时间
 */
const getCurrentDateTime = (padZero = false) => {
  const now = (0, dayjs_1.default)().tz(DEFAULT_TIMEZONE);
  // 补零
  const pad = num => (num < 10 ? `0${num}` : `${num}`);
  return {
    year: now.year().toString(),
    month: padZero ? pad(now.month() + 1) : (now.month() + 1).toString(),
    day: padZero ? pad(now.date()) : now.date().toString(),
    hour: padZero ? pad(now.hour()) : now.hour().toString(),
    minute: padZero ? pad(now.minute()) : now.minute().toString(),
    second: padZero ? pad(now.second()) : now.second().toString(),
  };
};
exports.getCurrentDateTime = getCurrentDateTime;
