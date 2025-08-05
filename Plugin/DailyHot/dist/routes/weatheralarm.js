"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleRoute = void 0;
const getData_js_1 = require("../utils/getData.js");
const getTime_js_1 = require("../utils/getTime.js");
const handleRoute = async (c, noCache) => {
    const province = c.req.query("province") || "";
    const listData = await getList({ province }, noCache);
    const routeData = {
        name: "weatheralarm",
        title: "中央气象台",
        type: `${province || "全国"}气象预警`,
        params: {
            province: {
                name: "预警区域",
                value: "省份名称（ 例如：广东省 ）",
            },
        },
        link: "http://nmc.cn/publish/alarm.html",
        total: listData.data?.length || 0,
        ...listData,
    };
    return routeData;
};
exports.handleRoute = handleRoute;
const getList = async (options, noCache) => {
    const { province } = options;
    const url = `http://www.nmc.cn/rest/findAlarm?pageNo=1&pageSize=20&signaltype=&signallevel=&province=${encodeURIComponent(province || "")}`;
    const result = await (0, getData_js_1.get)({ url, noCache });
    const list = result.data.data.page.list;
    return {
        ...result,
        data: list.map((v) => ({
            id: v.alertid,
            title: v.title,
            desc: v.issuetime + " " + v.title,
            cover: v.pic,
            timestamp: (0, getTime_js_1.getTime)(v.issuetime),
            hot: undefined,
            url: `http://nmc.cn${v.url}`,
            mobileUrl: `http://nmc.cn${v.url}`,
        })),
    };
};
