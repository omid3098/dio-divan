// متن بخش‌هایی از طراح جریان که با شرط‌ها و کتابخانه آمدند: شمارش اجراها، جعبهٔ شرط و بازرسش، بررسی‌های یک قاعده به زبان ساده،
// انتخاب‌گر پرامپت و شکل خروجی یک عامل، فیلدهای یک خط، و بررسی‌های تازهٔ طرح. با fa.ts یکی می‌شود.

import type { branchesEn } from './branches-en.ts';
import type { Msg } from './index.tsx';

export const branchesFa: Record<keyof typeof branchesEn, Msg> = {
  // ---------- the most calls a round can make ----------
  'flow.calls': {
    one: 'حداکثر {count} اجرای دستیار در هر دور',
    other: 'حداکثر {count} اجرای دستیار در هر دور',
  },
  'flow.calls.hint':
    'هر عاملی که شرکت می‌کند یک بار از دستیارش می‌پرسد. شاخه‌ای که کنار گذاشته شود عدد واقعی را کمتر می‌کند.',

  // ---------- a condition ----------
  'flow.palette.condition': 'شرط',
  'flow.palette.conditionHint': 'بسته به پاسخ یک عامل، طرح را به یک سمت یا سمت دیگر می‌فرستد.',
  'flow.palette.conditionCouncil':
    'شرط مال طرح است. اول با کشیدن یک خط یا افزودن نویسنده، این شورا را طرح کنید.',
  'flow.cond.kind': 'شرط',
  'flow.cond.name': 'شرط',
  'flow.cond.nameN': 'شرط {n}',
  'flow.cond.reads': 'می‌خواند: {name}',
  'flow.cond.noInput': 'هنوز چیزی نمی‌خواند',
  'flow.cond.noRules': 'هنوز قاعده‌ای نیست',
  'flow.cond.and': 'و',
  'flow.cond.or': 'یا',
  'flow.cond.more': '+{count} مورد دیگر',
  'flow.cond.yes': 'بله',
  'flow.cond.no': 'خیر',
  'flow.cond.yesTitle': 'بله: قاعده‌ها برقرارند',
  'flow.cond.noTitle': 'خیر: قاعده‌ها برقرار نیستند',
  'flow.cond.line': 'شرط · با کد تصمیم گرفته می‌شود',
  'flow.cond.info':
    'پاسخ یک عامل را می‌بیند و طرح را به خط «بله» یا خط «خیر» می‌فرستد. با کد و فوراً بررسی می‌شود: از هیچ دستیاری پرسیده نمی‌شود.',
  'flow.cond.delete': 'حذف این شرط',
  'flow.cond.readsTitle': 'می‌خواند',
  'flow.cond.select': 'انتخابش کن',
  'flow.cond.inputNone':
    'هنوز چیزی وصل نیست. از یک عامل خطی به نقطهٔ بالای این شرط بکشید. گزارش فیلد ندارد که بررسی شود، پس گزارش را نمی‌شود خواند.',
  'flow.cond.noFields': 'شکل خروجی این عامل فیلدی ندارد که قاعده بتواند بررسی کند.',
  'flow.cond.rules': 'قاعده‌ها',
  'flow.cond.mode': 'جواب «بله» است وقتی',
  'flow.cond.modeAll': 'همهٔ قاعده‌ها برقرار باشند',
  'flow.cond.modeAny': 'هر قاعده‌ای برقرار باشد',
  'flow.cond.noRulesYet': 'هنوز قاعده‌ای نیست. یکی بیفزایید: یک فیلد از پاسخ، یک بررسی و یک مقدار.',
  'flow.cond.noRulesNoInput': 'اول یک عامل وصل کنید: قاعده‌ها فیلدهای آن را بررسی می‌کنند.',
  'flow.cond.addRule': 'افزودن قاعده',
  'flow.cond.removeRule': 'حذف این قاعده',
  'flow.cond.field': 'فیلد',
  'flow.cond.check': 'بررسی',
  'flow.cond.value': 'مقدار',
  'flow.cond.pickField': 'یک فیلد انتخاب کنید',
  'flow.cond.fieldGone': 'ورودی دیگر فیلد «{field}» ندارد. فیلد دیگری انتخاب کنید.',
  'flow.cond.valueBad.number': 'یک عدد بنویسید.',
  'flow.cond.valueBad.count': 'یک عدد صحیح، 0 یا بیشتر، بنویسید.',
  'flow.cond.valueBad.text': 'متنی را که مقایسه می‌شود بنویسید (حداکثر 2,000 نویسه).',
  'flow.cond.valueBad.choice': 'یکی از گزینه‌های فیلد را انتخاب کنید.',
  'flow.cond.exits': 'خط‌ها',
  'flow.cond.leadsTo': 'به {names} می‌رود',
  'flow.cond.leadsNowhere': 'هنوز جایی نمی‌رود. از نقطه‌اش خطی بکشید.',
  'flow.cond.failed':
    'اگر عامل ناموفق بود یا کنار گذاشته شد، یا فیلد نبود یا خالی بود، جواب «خیر» است.',
  'flow.op.lt': 'کمتر از',
  'flow.op.le': 'حداکثر',
  'flow.op.gt': 'بیشتر از',
  'flow.op.ge': 'دست‌کم',
  'flow.op.eq': 'برابر',
  'flow.op.ne': 'برابر نیست با',
  'flow.op.empty': 'خالی است',
  'flow.op.notEmpty': 'خالی نیست',
  'flow.op.contains': 'شامل',
  'flow.op.equals': 'برابر',
  'flow.op.true': 'درست است',
  'flow.op.false': 'نادرست است',
  'flow.op.is': 'برابر',
  'flow.op.isNot': 'برابر نیست با',
  'flow.op.countLt': 'تعداد: کمتر از',
  'flow.op.countLe': 'تعداد: حداکثر',
  'flow.op.countGt': 'تعداد: بیشتر از',
  'flow.op.countGe': 'تعداد: دست‌کم',
  'flow.op.countEq': 'تعداد: دقیقاً',
  'flow.op.countNe': 'تعداد: نه',
  'flow.rule.empty': '{field} خالی است',
  'flow.rule.notEmpty': '{field} خالی نیست',
  'flow.rule.contains': '{field} شامل {value} است',
  'flow.rule.equals': '{field} برابر {value} است',
  'flow.rule.true': '{field} درست است',
  'flow.rule.false': '{field} نادرست است',
  'flow.rule.is': '{field} برابر {value} است',
  'flow.rule.isNot': '{field} برابر {value} نیست',
  'flow.rule.countLt': {
    one: '{field} کمتر از {value} مورد دارد',
    other: '{field} کمتر از {value} مورد دارد',
  },
  'flow.rule.countLe': {
    one: '{field} حداکثر {value} مورد دارد',
    other: '{field} حداکثر {value} مورد دارد',
  },
  'flow.rule.countGt': {
    one: '{field} بیشتر از {value} مورد دارد',
    other: '{field} بیشتر از {value} مورد دارد',
  },
  'flow.rule.countGe': {
    one: '{field} دست‌کم {value} مورد دارد',
    other: '{field} دست‌کم {value} مورد دارد',
  },
  'flow.rule.countEq': {
    one: '{field} دقیقاً {value} مورد دارد',
    other: '{field} دقیقاً {value} مورد دارد',
  },
  'flow.rule.countNe': {
    one: '{field} {value} مورد ندارد',
    other: '{field} {value} مورد ندارد',
  },
  'flow.receives.gateYes': 'فقط وقتی اجرا می‌شود که «{name}» بگوید بله',
  'flow.receives.gateNo': 'فقط وقتی اجرا می‌شود که «{name}» بگوید خیر',

  // ---------- the pickers of an agent's prompt and output form ----------
  'flow.pick.builtin': 'آماده',
  'flow.pick.openLibrary': 'باز کردن در کتابخانه',
  'flow.pick.newFrom': 'ساختن از روی این…',
  'flow.pick.showAll': 'نشان دادن همه ({count} مورد دیگر)',
  'flow.pick.onlyFit': 'فقط موارد مناسب',
  'flow.pick.loading': 'در حال بارگذاری کتابخانه…',
  'flow.pick.formHint':
    'شکل خروجی می‌گوید پاسخ چه فیلدهایی دارد. فقط شکل‌هایی که به این جای طرح می‌خورند فهرست شده‌اند.',
  'flow.pick.promptHint':
    'پرامپت یکی از موردهای کتابخانه است: ویرایشش آنجا روی همهٔ مدل‌هایی که از آن استفاده می‌کنند اثر می‌گذارد. فقط پرامپت‌هایی که به شکل و ورودی این عامل می‌خورند فهرست شده‌اند.',

  // ---------- a line of a condition, the fields on a line ----------
  'flow.edge.gateTitle': 'خط یک شرط',
  'flow.edge.gateYes': '«{to}» فقط وقتی اجرا می‌شود که «{from}» بگوید بله. این خط پاسخی نمی‌رساند.',
  'flow.edge.gateNo': '«{to}» فقط وقتی اجرا می‌شود که «{from}» بگوید خیر. این خط پاسخی نمی‌رساند.',
  'flow.edge.read': '«{to}» پاسخ «{from}» را می‌خواند.',
  'flow.edge.fields': 'فیلدهای این خط',
  'flow.edge.onlyWhen': 'فقط وقتی',
  'flow.edge.always': 'همیشه',
  'flow.edge.whenChoice': '{name}: {exit}',
  'flow.edge.onlyYes': 'فقط اگر بله',
  'flow.edge.onlyNo': 'فقط اگر خیر',
  'flow.problem.when':
    'خطی که از «{name}» می‌آید باید یک شرط معتبر و خروجی بله یا خیر آن را داشته باشد.',
  'flow.edge.fieldsAll': 'همهٔ فیلدها',
  'flow.edge.fieldsSome': 'انتخاب فیلدها',
  'flow.edge.fieldsAllHint': 'کل پاسخ از این خط می‌گذرد.',
  'flow.edge.fieldsHint':
    '«{to}» فقط فیلدهای تیک‌خورده از این پاسخ را می‌بیند و هیچ چیز دیگری از آن را نه.',
  'flow.edge.fieldsLast': 'هر خط دست‌کم یک فیلد می‌رساند.',
  'flow.edge.fieldCount': '{n} از {total} فیلد',
  'flow.edge.role': '«{to}» چطور از این پاسخ استفاده کند',
  'flow.edge.roleRequired': 'لازم',
  'flow.edge.roleGroup': 'یکی از پاسخ‌ها',
  'flow.edge.roleHint':
    'دو سمت یک شرط جانشین هم‌اند: فقط یکی‌شان اجرا می‌شود. هرکدام را «یکی از پاسخ‌ها» بگذارید، وگرنه عاملی که به آن می‌رسند هر وقت سمت دیگر اجرا شود کنار گذاشته می‌شود.',

  // ---------- more checks, in words ----------
  'flow.problem.gate':
    'خط «{name}» مجاز نیست: خط‌های «بله» و «خیر» یک شرط به یک عامل یا شرط دیگر می‌روند.',
  'flow.problem.fields':
    'خطی که از «{name}» می‌آید فیلدهایی می‌رساند که پاسخش ندارد، یا هیچ فیلدی نمی‌رساند. فیلدهایش را دوباره انتخاب کنید.',
  'flow.problem.condInput':
    '«{name}» باید دقیقاً یک عامل را بخواند که پاسخش فیلد دارد. گزارش فیلد ندارد.',
  'flow.problem.condRules': '«{name}» از 1 تا 30 قاعده لازم دارد.',
  'flow.problem.condField':
    '«{name}» فیلدی را بررسی می‌کند که «{source}» ندارد. فیلد را دوباره انتخاب کنید.',
  'flow.problem.condOperator':
    'یکی از قاعده‌های «{name}» بررسی‌ای دارد که فیلدش نمی‌تواند داشته باشد. بررسی را دوباره انتخاب کنید.',
  'flow.problem.condValue': 'یکی از قاعده‌های «{name}» مقداری ندارد یا مقدارش مجاز نیست.',
  'flow.problem.condExits': '«{name}» یک خط برای «بله» و یک خط برای «خیر» لازم دارد.',
  'flow.refused.gateToOutput': 'خط‌های «بله» و «خیر» یک شرط به یک عامل می‌روند، نه مستقیم به پاسخ.',
  'flow.refused.conditionNeedsAgent':
    'شرط پاسخ یک عامل را می‌خواند. پرسش شما فیلدی ندارد که بررسی شود.',
  'flow.refused.conditionNeedsFields':
    'گزارش یک متن است و فیلدی ندارد که بررسی شود. شرط عاملی را می‌خواند که شکل خروجی‌اش فیلد دارد.',
  'flow.refused.conditionTaken':
    'شرط فقط یک عامل را می‌خواند و این یکی از قبل عامل دیگری را می‌خواند. اول آن خط را حذف کنید.',
};
