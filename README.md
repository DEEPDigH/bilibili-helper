# Bilibili Helper

A collection of scripts and tools to make everyday tasks on Bilibili easier.

三个独立的 Tampermonkey 用户脚本，可以按需安装。

## 脚本

| 脚本 | 版本 | 用途 | 安装 |
| --- | --- | --- | --- |
| B站已参与抽奖备忘录 | 0.7.0 | 记录已参与活动、开奖时间和 UP 主信息，提供本地提醒与备份导入导出 | [安装](https://raw.githubusercontent.com/DEEPDigH/bilibili-helper/main/bili-reminder.user.js) |
| B站关注分组助手 | 0.3.10 | 手动关注成功后选择分组，支持设置后续关注的默认分组 | [安装](https://raw.githubusercontent.com/DEEPDigH/bilibili-helper/main/bili-follow-groups.user.js) |
| B站原生批量管理 | 0.1.5 | 在个人空间管理关注与转发动态，执行前预览，串行处理并核实结果 | [安装](https://raw.githubusercontent.com/DEEPDigH/bilibili-helper/main/bili-batch-manager.user.js) |

## 安装与更新

1. 在浏览器中安装 [Tampermonkey](https://www.tampermonkey.net/)。
2. 点击上表的安装链接，在 Tampermonkey 页面确认安装。
3. 如果只显示代码，在 Tampermonkey 中新建脚本，将对应 `.user.js` 文件的完整内容粘贴进去并保存。
4. 刷新 B 站页面。浏览器若提示需要用户脚本权限，请按 Tampermonkey 的提示开启。

更新时编辑已有脚本并替换完整代码，保存后刷新页面；不要重复安装多个副本。替换前可导出重要的本地记录。当前脚本未配置仓库自动更新地址，上传新版本不会自动更新浏览器中已安装的副本。

## 使用

### 抽奖备忘录

打开自己的个人空间动态页，检查自己的转发记录；其他活动可在详情页手动记录。活动时间和结果可以手动填写或更正。

- 只记录与提醒，不自动参与抽奖、投币或判断中奖。
- “已记录转发”不等于已满足活动的全部参与条件。
- 删除备忘录中的本地记录不会删除 B 站动态。
- 数据保存在 Tampermonkey 的本地存储中，可在面板中导出和导入。
- 关闭浏览器或没有相关页面打开时，无法保证准时提醒。

### 关注分组助手

在 B 站页面手动关注 UP 主，成功后使用分组选择界面；也可以设置后续关注的默认分组。

### 原生批量管理

在自己的个人空间关注页或动态页使用批量管理入口。执行前核对预览中的对象和操作，关注变更与动态删除会实际修改 B 站账号内容。

## 数据与兼容性

脚本使用当前浏览器登录状态访问 B 站内部接口，没有附带账号密码、Cookie 或个人活动记录。源码发布到 GitHub 不会同步用户的本地记录。

这些工具并非 B 站官方项目。页面或接口变更可能导致功能失效；遇到登录失效、风控或接口限制时，请停止操作并核实。

## License

[MIT](LICENSE)
