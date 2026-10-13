'use strict';
// fileKit：FileOperator 与 ProjectForge 共用的文件工具集。
// 位于 Plugin/ 之外，不会被 PluginManager 当作插件扫描。

module.exports = {
    paths: require('./paths'),
    text: require('./text'),
    validator: require('./validator'),
    reader: require('./reader'),
    diff: require('./diff'),
    output: require('./output'),
};