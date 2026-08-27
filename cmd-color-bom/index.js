/**
 * CMD产品颜色BOM查询工具 - 后端逻辑
 * 数据源: 飞书多维表格 Ir1Ub5Akja0UfHs0gnnc6592nPf
 */

const COLOR_DATA = [
  {id:"NO.001",color_code:"02B",color_name:"高亮黑_02B",category:"黑色系",area:"EXT_SML",model:"车型C LUX",material:"ABS/PC",process:"高光喷涂",status:"待确认"},
  {id:"NO.002",color_code:"01B",color_name:"曜石黑_01B",category:"黑色系",area:"EXT_SML",model:"车型C LUX",material:"ABS/PC",process:"喷涂",status:"待确认"},
  {id:"NO.003",color_code:"车身色",color_name:"车身色",category:"特殊",area:"EXT_SML",model:"车型C LUX",material:"N/A",process:"随车身色",status:"待确认"},
  {id:"NO.004",color_code:"90R",color_name:"明红_90R",category:"红色系",area:"EXT_SML",model:"车型C LUX",material:"ABS/PC",process:"明红喷涂",status:"待确认"},
  {id:"NO.005",color_code:"MG02",color_name:"深空灰_MG02",category:"灰色系",area:"EXT_SML",model:"车型C LUX",material:"铝合金",process:"深空灰喷涂",status:"待确认"},
  {id:"NO.006",color_code:"/",color_name:"/",category:"未定义",area:"EXT_SML",model:"车型C LUX",material:"N/A",process:"N/A",status:"待确认"},
  {id:"NO.007",color_code:"黑色",color_name:"黑色",category:"黑色系",area:"EXT_SML",model:"车型C LUX",material:"ABS/PC",process:"喷涂",status:"待确认"},
  {id:"NO.008",color_code:"银色+黑色",color_name:"银色+黑色",category:"双色系",area:"EXT_SML",model:"车型C LUX",material:"铝合金+ABS",process:"阳极氧化+喷涂",status:"待确认"},
  {id:"NO.009",color_code:"XB01",color_name:"熏黑_XB01",category:"黑色系",area:"EXT_SML",model:"车型C LUX",material:"玻璃/PC",process:"镀膜熏黑",status:"待确认"},
  {id:"NO.010",color_code:"02B+Al 精车",color_name:"高亮黑_02B+Al 精车",category:"黑色系",area:"EXT_SML",model:"车型C LUX",material:"铝合金",process:"高光喷涂+精车",status:"待确认"},
  {id:"NO.011",color_code:"02B+Al本色",color_name:"高亮黑_02B+Al本色",category:"黑色系",area:"EXT_SML",model:"车型C LUX",material:"铝合金",process:"高光喷涂+阳极氧化",status:"待确认"},
  {id:"NO.012",color_code:"01B",color_name:"高亮黄_02Y+曜石黑_01B",category:"双色系",area:"EXT_SML",model:"车型C LUX",material:"ABS/PC",process:"双色喷涂",status:"待确认"},
  {id:"NO.013",color_code:"G02",color_name:"高亮黑_02B+细皮纹02_G02",category:"黑色系",area:"EXT_SML",model:"车型C LUX",material:"ABS/PC",process:"高光喷涂+皮纹蚀刻",status:"待确认"},
  {id:"NO.014",color_code:"01S",color_name:"银色_01S",category:"银色系",area:"EXT_SML",model:"车型C LUX",material:"铝合金",process:"阳极氧化/喷涂",status:"待确认"},
  {id:"NO.015",color_code:"无色透明",color_name:"无色透明",category:"透明系",area:"EXT_SML",model:"车型C LUX",material:"PC/PMMA",process:"注塑透明",status:"待确认"},
  {id:"NO.016",color_code:"透明",color_name:"透明",category:"透明系",area:"EXT_SML",model:"车型C LUX",material:"PC/PMMA",process:"注塑透明",status:"待确认"},
  {id:"NO.017",color_code:"黑色+透明",color_name:"黑色+透明",category:"透明系",area:"EXT_SML",model:"车型C LUX",material:"PC/PMMA",process:"注塑+局部透明",status:"待确认"},
  {id:"NO.018",color_code:"黑色+锈不锈钢",color_name:"黑色+锈不锈钢",category:"金属系",area:"EXT_SML",model:"车型C LUX",material:"不锈钢",process:"做旧处理+局部喷涂",status:"待确认"},
  {id:"NO.019",color_code:"3K斜纹碳纤维",color_name:"3K斜纹碳纤维",category:"碳纤维系",area:"EXT_SML",model:"车型C LUX",material:"碳纤维",process:"3K斜纹编织+环氧树脂",status:"待确认"},
  {id:"NO.020",color_code:"闪银灰 MG03",color_name:"闪银灰 MG03",category:"银色系",area:"EXT_SML",model:"车型C LUX",material:"铝合金",process:"闪银灰喷涂",status:"待确认"},
  {id:"NO.021",color_code:"潘通11C",color_name:"潘通11C",category:"其他",area:"EXT_SML",model:"车型C LUX",material:"ABS/PC",process:"潘通色喷涂",status:"待确认"},
  {id:"NO.022",color_code:"MG05",color_name:"金属岩石灰_MG05",category:"灰色系",area:"EXT_SML",model:"车型C LUX",material:"铝合金",process:"金属灰喷涂",status:"待确认"},
  {id:"NO.023",color_code:"06R",color_name:"宝石红_06R",category:"红色系",area:"EXT_SML",model:"车型C LUX",material:"ABS/PC",process:"宝石红喷涂",status:"待确认"},
  {id:"NO.024",color_code:"MC03",color_name:"淡泊金_MC03",category:"金色系",area:"EXT_SML",model:"车型C LUX",material:"铝合金",process:"淡泊金喷涂",status:"待确认"},
  {id:"NO.025",color_code:"3K斜纹碳纤维",color_name:"3K斜纹碳纤维",category:"碳纤维系",area:"EXT_SML",model:"车型C LUX",material:"碳纤维",process:"3K斜纹编织+环氧树脂",status:"待确认"},
  {id:"NO.026",color_code:"01S",color_name:"3K斜纹碳纤维+银色水标_01S",category:"碳纤维系",area:"EXT_SML",model:"车型C LUX",material:"碳纤维",process:"3K斜纹+银色水转印",status:"待确认"},
  {id:"NO.027",color_code:"08R",color_name:"潘通11C+凌动红_08R",category:"双色系",area:"EXT_SML",model:"车型C LUX",material:"ABS/PC",process:"双色喷涂",status:"待确认"},
  {id:"NO.028",color_code:"06R+RAL9016",color_name:"宝石红_06R+RAL9016",category:"双色系",area:"EXT_SML",model:"车型C LUX",material:"ABS/PC",process:"宝石红+白色双色喷涂",status:"待确认"},
  {id:"NO.029",color_code:"TBD",color_name:"TBD",category:"待定",area:"EXT_SML",model:"车型C LUX",material:"TBD",process:"TBD",status:"待确认"},
  {id:"NO.030",color_code:"矿石灰_",color_name:"矿石灰_",category:"灰色系",area:"EXT_SML",model:"车型C LUX",material:"ABS/PC",process:"矿石灰喷涂",status:"待确认"},
  {id:"NO.031",color_code:"Pantone Cool Gray 11C",color_name:"Pantone Cool Gray 11C",category:"灰色系",area:"EXT_SML",model:"车型C LUX",material:"ABS/PC",process:"潘通色喷涂",status:"待确认"},
  {id:"NO.032",color_code:"05B",color_name:"星钻黑_05B",category:"黑色系",area:"EXT_SML",model:"车型C LUX",material:"ABS/PC",process:"喷涂+闪粉",status:"待确认"},
  {id:"NO.033",color_code:"02B+精车+闪银灰",color_name:"高亮黑_02B+精车+闪银灰",category:"黑色系",area:"EXT_SML",model:"车型C LUX",material:"铝合金",process:"高光喷涂+精车+闪银灰喷涂",status:"待确认"},
  {id:"NO.034",color_code:"02B+锻造铝本色",color_name:"高亮黑_02B+锻造铝本色",category:"黑色系",area:"EXT_SML",model:"车型C LUX",material:"锻造铝合金",process:"高光喷涂+锻造铝本色阳极",status:"待确认"},
  {id:"NO.035",color_code:"MG06",color_name:"铠衣灰_MG06",category:"灰色系",area:"EXT_SML",model:"车型C LUX",material:"铝合金",process:"铠衣灰喷涂",status:"待确认"},
  {id:"NO.036",color_code:"武士黑",color_name:"武士黑",category:"黑色系",area:"EXT_SML",model:"车型C LUX",material:"ABS/PC",process:"武士黑喷涂",status:"待确认"},
  {id:"NO.037",color_code:"驼卡其",color_name:"驼卡其",category:"暖色系",area:"EXT_SML",model:"车型C LUX",material:"ABS/PC",process:"驼卡其喷涂",status:"待确认"},
  {id:"NO.038",color_code:"砂陶米",color_name:"砂陶米",category:"暖色系",area:"EXT_SML",model:"车型C LUX",material:"ABS/PC",process:"砂陶米喷涂",status:"待确认"},
  {id:"NO.039",color_code:"MB06",color_name:"暗夜银_MB06",category:"灰色系",area:"EXT_SML",model:"车型C LUX",material:"铝合金",process:"暗夜银喷涂",status:"待确认"},
  {id:"NO.040",color_code:"高亮黑+抛光",color_name:"高亮黑+抛光",category:"黑色系",area:"EXT_SML",model:"车型C LUX",material:"不锈钢/铝合金",process:"抛光",status:"待确认"},
  {id:"NO.041",color_code:"闪镀银",color_name:"闪镀银",category:"银色系",area:"EXT_SML",model:"车型C LUX",material:"ABS/PC",process:"真空镀膜",status:"待确认"},
  {id:"NO.042",color_code:"哑光黑",color_name:"哑光黑",category:"黑色系",area:"EXT_SML",model:"车型C LUX",material:"ABS/PC",process:"哑光喷涂",status:"待确认"},
  {id:"NO.043",color_code:"墨影灰 MG11",color_name:"墨影灰 MG11",category:"灰色系",area:"EXT_SML",model:"车型C LUX",material:"铝合金",process:"墨影灰喷涂",status:"待确认"},
  {id:"NO.044",color_code:"高亮黑+抛光+清漆",color_name:"高亮黑+抛光+清漆",category:"黑色系",area:"EXT_SML",model:"车型C LUX",material:"不锈钢/铝合金",process:"抛光+清漆",status:"待确认"},
  {id:"NO.045",color_code:"02B+精车+页岩黑 MB07",color_name:"高亮黑_02B+精车+页岩黑 MB07",category:"黑色系",area:"EXT_SML",model:"车型C LUX",material:"铝合金",process:"高光喷涂+精车+页岩黑喷涂",status:"待确认"},
  {id:"NO.046",color_code:"页岩黑",color_name:"页岩黑",category:"灰色系",area:"EXT_SML",model:"车型C LUX",material:"ABS/PC",process:"页岩黑喷涂",status:"待确认"},
  {id:"NO.047",color_code:"MS10",color_name:"高光银_MS10",category:"银色系",area:"EXT_SML",model:"车型C LUX",material:"铝合金",process:"高光银喷涂",status:"待确认"},
  {id:"NO.048",color_code:"高光金",color_name:"高光金",category:"金色系",area:"EXT_SML",model:"车型C LUX",material:"铝合金",process:"高光金喷涂",status:"待确认"},
  {id:"NO.049",color_code:"高光黑铬",color_name:"高光黑铬",category:"金属系",area:"EXT_SML",model:"车型C LUX",material:"ABS/PC",process:"黑铬电镀",status:"待确认"},
  {id:"NO.050",color_code:"12G",color_name:"薄雾灰_12G",category:"灰色系",area:"EXT_SML",model:"车型C LUX",material:"ABS/PC",process:"薄雾灰喷涂",status:"待确认"},
  {id:"NO.051",color_code:"大象灰 （NEW）",color_name:"大象灰 （NEW）",category:"灰色系",area:"EXT_SML",model:"车型C LUX",material:"ABS/PC",process:"大象灰喷涂",status:"待确认"},
  {id:"NO.052",color_code:"09R",color_name:"胭脂红_09R",category:"红色系",area:"EXT_SML",model:"车型C LUX",material:"ABS/PC",process:"胭脂红喷涂",status:"待确认"},
  {id:"NO.053",color_code:"闪电紫（NEW）",color_name:"闪电紫（NEW）",category:"紫色系",area:"EXT_SML",model:"车型C LUX",material:"ABS/PC",process:"闪电紫喷涂",status:"待确认"},
  {id:"NO.054",color_code:"07Z",color_name:"拿铁棕_07Z",category:"暖色系",area:"EXT_SML",model:"车型C LUX",material:"ABS/PC",process:"拿铁棕喷涂",status:"待确认"},
  {id:"NO.055",color_code:"O8Q",color_name:"普鲁士蓝_O8Q",category:"蓝色系",area:"EXT_SML",model:"车型C LUX",material:"ABS/PC",process:"普鲁士蓝喷涂",status:"待确认"},
  {id:"NO.056",color_code:"陶瓷白",color_name:"陶瓷白",category:"白色系",area:"EXT_SML",model:"车型C LUX",material:"ABS/PC",process:"陶瓷白喷涂",status:"待确认"},
  {id:"NO.057",color_code:"水晶黑",color_name:"水晶黑",category:"黑色系",area:"EXT_SML",model:"车型C LUX",material:"ABS/PC",process:"水晶黑喷涂",status:"待确认"},
  {id:"NO.058",color_code:"08R",color_name:"凌动红_08R",category:"红色系",area:"EXT_SML",model:"车型C LUX",material:"ABS/PC",process:"凌动红喷涂",status:"待确认"},
  {id:"NO.059",color_code:"MB12",color_name:"镜面黑铬_MB12",category:"金属系",area:"EXT_SML",model:"车型C LUX",material:"ABS/PC",process:"镜面黑铬电镀",status:"待确认"},
  {id:"NO.060",color_code:"镀铝拉丝",color_name:"镀铝拉丝",category:"金属系",area:"EXT_SML",model:"车型C LUX",material:"铝合金",process:"拉丝+阳极氧化",status:"待确认"},
  {id:"NO.061",color_code:"04Q",color_name:"蝴蝶兰_04Q",category:"蓝色系",area:"EXT_SML",model:"车型C LUX",material:"ABS/PC",process:"蝴蝶兰喷涂",status:"待确认"},
  {id:"NO.062",color_code:"15Q",color_name:"暗夜蓝_15Q",category:"蓝色系",area:"EXT_SML",model:"车型C LUX",material:"ABS/PC",process:"暗夜蓝喷涂",status:"待确认"},
  {id:"NO.063",color_code:"MC12+精车铝本色",color_name:"古铜金_MC12+精车铝本色",category:"双色系",area:"EXT_SML",model:"车型C LUX",material:"铝合金",process:"古铜金喷涂+精车铝本色",status:"待确认"},
  {id:"NO.064",color_code:"MB04",color_name:"石墨黑_MB04",category:"黑色系",area:"EXT_SML",model:"车型C LUX",material:"ABS/PC",process:"石墨黑喷涂",status:"待确认"},
  {id:"NO.065",color_code:"MB11+精车铝本色",color_name:"至臻黑_MB11+精车铝本色",category:"双色系",area:"EXT_SML",model:"车型C LUX",material:"铝合金",process:"至臻黑喷涂+精车铝本色",status:"待确认"},
  {id:"NO.066",color_code:"紫色（TBD）+精车铝本色",color_name:"紫色（TBD）+精车铝本色",category:"双色系",area:"EXT_SML",model:"车型C LUX",material:"铝合金",process:"紫色喷涂+精车铝本色（TBD）",status:"待确认"},
  {id:"NO.067",color_code:"高亮黑+抛光铝本色",color_name:"高亮黑+抛光铝本色",category:"双色系",area:"EXT_SML",model:"车型C LUX",material:"铝合金",process:"高光喷涂+抛光铝本色",status:"待确认"},
  {id:"NO.068",color_code:"高亮黑+铝本色",color_name:"高亮黑+铝本色",category:"双色系",area:"EXT_SML",model:"车型C LUX",material:"铝合金",process:"高光喷涂+铝本色阳极",status:"待确认"},
  {id:"NO.069",color_code:"MG01",color_name:"金属灰_MG01",category:"灰色系",area:"EXT_SML",model:"车型C LUX",material:"铝合金",process:"金属灰喷涂",status:"待确认"},
  {id:"NO.070",color_code:"铝本色",color_name:"铝本色",category:"金属系",area:"EXT_SML",model:"车型C LUX",material:"铝合金",process:"阳极氧化",status:"待确认"}
];

const TEXTURE_DATA = [
  {id:"NO.001",platform:"车型C",category:"注塑纹理",code:"细砂纹01_G01"},
  {id:"NO.002",platform:"车型C",category:"电火花纹理",code:"电火花01"},
  {id:"NO.003",platform:"车型C",category:"电火花纹理",code:"MT80611"},
  {id:"NO.004",platform:"车型C",category:"表面处理",code:"消光"},
  {id:"NO.005",platform:"All",category:"表面处理",code:"抛光"},
  {id:"NO.006",platform:"All",category:"表面处理",code:"拉丝"},
  {id:"NO.007",platform:"",category:"表面处理",code:"拉丝沿长边方向"},
  {id:"NO.008",platform:"",category:"",code:"/"},
  {id:"NO.009",platform:"车型C",category:"注塑纹理",code:"细砂纹02_G02"},
  {id:"NO.010",platform:"",category:"电火花纹理",code:"VDI33 电火花"},
  {id:"NO.011",platform:"",category:"注塑纹理",code:"抛光+细皮纹02_G02"},
  {id:"NO.012",platform:"",category:"",code:"亚艺达GT-7019"},
  {id:"NO.013",platform:"",category:"",code:"天至尊 TZZ-L317"},
  {id:"NO.014",platform:"",category:"",code:"亚艺达GT-7019+天至尊TZZ-L317"},
  {id:"NO.015",platform:"",category:"碳纤维",code:"3K 碳纤维斜纹"},
  {id:"NO.016",platform:"",category:"电火花纹理",code:"VDI33电火花+消光"},
  {id:"NO.017",platform:"",category:"织物",code:"防水织物"},
  {id:"NO.018",platform:"",category:"织物",code:"纱网"},
  {id:"NO.019",platform:"",category:"注塑纹理",code:"砂纹03_G03"},
  {id:"NO.020",platform:"",category:"注塑纹理",code:"Baby Skin_G04"},
  {id:"NO.021",platform:"",category:"注塑纹理",code:"织物纹_G30"},
  {id:"NO.022",platform:"",category:"注塑纹理",code:"织物纹_G30+地图袋底部细砂纹01_G01"},
  {id:"NO.023",platform:"",category:"注塑纹理",code:"细砂纹01_G01_字符侧壁及底部喷砂消光"},
  {id:"NO.024",platform:"",category:"注塑纹理",code:"细砂纹01_G01_字符底部及侧壁消光喷砂"},
  {id:"NO.025",platform:"",category:"注塑纹理",code:"细砂纹01_G01_插拔面消光处理"},
  {id:"NO.026",platform:"",category:"注塑纹理",code:"细砂纹01_G01+仿细砂纹01电火花"},
  {id:"NO.027",platform:"",category:"注塑纹理",code:"细砂纹01_G01_AIRBAG字符消光"},
  {id:"NO.028",platform:"",category:"注塑纹理",code:"砂纹03_G03_软胶位置消光"},
  {id:"NO.029",platform:"",category:"注塑纹理",code:"织物纹_G30+砂纹03_G03"},
  {id:"NO.030",platform:"",category:"注塑纹理",code:"粗磨砂_GA06"},
  {id:"NO.031",platform:"",category:"注塑纹理",code:"细磨砂_GA08"},
  {id:"NO.032",platform:"",category:"注塑纹理",code:"Baby Skin_GA01"},
  {id:"NO.033",platform:"",category:"注塑纹理",code:"GA02_GA02"},
  {id:"NO.034",platform:"",category:"缝线",code:"单缝，上压下"},
  {id:"NO.035",platform:"",category:"缝线",code:"双缝线"},
  {id:"NO.036",platform:"",category:"织物",code:"针刺起绒"},
  {id:"NO.037",platform:"",category:"织物",code:"平绒"},
  {id:"NO.038",platform:"",category:"缝线",code:"30mm7针"},
  {id:"NO.039",platform:"",category:"表面处理",code:"CD纹"},
  {id:"NO.040",platform:"",category:"表面处理",code:"高亮素色喷漆"},
  {id:"NO.041",platform:"",category:"表面处理",code:"软触漆"},
  {id:"NO.042",platform:"",category:"特殊工艺",code:"压印"},
  {id:"NO.043",platform:"",category:"特殊工艺",code:"背面光学花纹"},
  {id:"NO.044",platform:"",category:"特殊工艺",code:"Rukaflex"},
  {id:"NO.045",platform:"",category:"特殊工艺",code:"封样件"},
  {id:"NO.046",platform:"",category:"缝线",code:"欧式缝线"},
  {id:"NO.047",platform:"",category:"表面处理",code:"半哑光"},
  {id:"NO.048",platform:"",category:"表面处理",code:"软触"},
  {id:"NO.049",platform:"",category:"表面处理",code:"磨砂"},
  {id:"NO.050",platform:"",category:"注塑纹理",code:"砂纹03_G03_字符底部及侧壁消光喷砂"},
  {id:"NO.051",platform:"",category:"注塑纹理",code:"砂纹03_G03+电火花01"},
  {id:"NO.052",platform:"",category:"表面处理",code:"半哑光+铣削高光"},
  {id:"NO.053",platform:"",category:"电火花纹理",code:"VDI 45"},
  {id:"NO.054",platform:"",category:"表面处理",code:"哑光"},
  {id:"NO.055",platform:"",category:"",code:"TBD"},
  {id:"NO.056",platform:"",category:"表面处理",code:"哑光金属漆"},
  {id:"NO.057",platform:"",category:"电火花纹理",code:"VDI 27"},
  {id:"NO.058",platform:"",category:"电火花纹理",code:"VDI 24"},
  {id:"NO.059",platform:"",category:"注塑纹理",code:"GA07"},
  {id:"NO.060",platform:"",category:"缝线",code:"30mm8针"},
  {id:"NO.061",platform:"",category:"电火花纹理",code:"VDI 30"},
  {id:"NO.062",platform:"",category:"缝线",code:"30mm7针，双缝线"},
  {id:"NO.063",platform:"",category:"织物",code:"Lock织物"},
  {id:"NO.064",platform:"",category:"织物",code:"仿麂皮"},
  {id:"NO.065",platform:"",category:"织物",code:"织物仿麂皮Fuzzy"},
  {id:"NO.066",platform:"",category:"特殊工艺",code:"云雾纹"},
  {id:"NO.067",platform:"",category:"电火花纹理",code:"VDI33"},
  {id:"NO.068",platform:"",category:"电火花纹理",code:"M20"},
  {id:"NO.069",platform:"",category:"特殊工艺",code:"供应商参考纹理"},
  {id:"NO.070",platform:"",category:"",code:"G02+火花纹"},
  {id:"NO.071",platform:"",category:"织物",code:"簇绒毯面"},
  {id:"NO.072",platform:"",category:"表面处理",code:"高亮"},
  {id:"NO.073",platform:"",category:"注塑纹理",code:"G05"}
];

function queryColors(kw) {
  const lower = kw.toLowerCase();
  return COLOR_DATA.filter(r =>
    r.category.indexOf(lower) >= 0 ||
    r.color_name.toLowerCase().indexOf(lower) >= 0 ||
    r.color_code.toLowerCase().indexOf(lower) >= 0 ||
    r.material.toLowerCase().indexOf(lower) >= 0 ||
    r.process.toLowerCase().indexOf(lower) >= 0
  );
}

function queryTextures(kw) {
  const lower = kw.toLowerCase();
  return TEXTURE_DATA.filter(r =>
    (r.category || '').toLowerCase().indexOf(lower) >= 0 ||
    r.code.toLowerCase().indexOf(lower) >= 0
  );
}

function crossQuery(kw) {
  const colors = queryColors(kw);
  const textures = queryTextures(kw);
  const all = [];
  colors.forEach(c => all.push(c));
  textures.forEach(t => {
    all.push({id: t.id, color_code: t.code, color_name: t.code, category: t.category || '未分类', material: t.platform || '-', process: '-', area: '-', status: '-'});
  });
  return all;
}

function getSummary(colors) {
  const cats = {}, mats = {}, procs = {};
  colors.forEach(r => {
    cats[r.category] = (cats[r.category] || 0) + 1;
    mats[r.material] = (mats[r.material] || 0) + 1;
    procs[r.process] = (procs[r.process] || 0) + 1;
  });
  return {
    total: colors.length,
    categories: Object.keys(cats).length,
    materials: Object.keys(mats).length,
    processes: Object.keys(procs).length
  };
}

exports.run = async function(params) {
  const queryType = params.queryType || '全部颜色';
  const keyword = params.keyword || '';
  let result = [];
  let summary = null;

  if (queryType === '全部颜色') {
    result = COLOR_DATA;
    summary = getSummary(COLOR_DATA);
  } else if (queryType === '按颜色分类' || queryType === '按颜色名称' || queryType === '按颜色编码') {
    if (!keyword) return { error: '请输入查询关键词' };
    result = queryColors(keyword);
    if (result.length > 0) summary = getSummary(result);
  } else if (queryType === '全部纹理') {
    result = TEXTURE_DATA;
  } else if (queryType === '按纹理分类' || queryType === '按纹理代码') {
    if (!keyword) return { error: '请输入查询关键词' };
    result = queryTextures(keyword);
  } else if (queryType === '全量汇总') {
    summary = getSummary(COLOR_DATA);
    summary.colorCount = COLOR_DATA.length;
    summary.textureCount = TEXTURE_DATA.length;
    result = [{type: '汇总', total: summary.total + summary.textureCount}];
  } else if (queryType === '交叉查询') {
    if (!keyword) return { error: '请输入查询关键词' };
    result = crossQuery(keyword);
  } else {
    return { error: '未知查询类型' };
  }

  return {
    result: result,
    summary: summary,
    recordCount: result.length
  };
};
