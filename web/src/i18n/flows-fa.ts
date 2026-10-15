// متن طراح جریان در صفحهٔ شوراها به فارسی. با fa.ts یکی می‌شود. «عامل» همان جعبهٔ یک دستیار در طرح است؛
// «دستیار» در این صفحه همان ابزار (Claude Code، Codex و …) است.

import type { flowsEn } from './flows-en.ts';
import type { Msg } from './index.tsx';

export const flowsFa: Record<keyof typeof flowsEn, Msg> = {
  // ---------- starting a design ----------
  'flow.template.single.hint':
    'یک دستیار مستقیم به پرسش پاسخ می‌دهد. از اینجا شروع کنید و ساختار خودتان را بسازید.',
  'flow.role.assistant': 'دستیار',
  'flow.startFrom': 'شروع از',
  'flow.template.council.hint':
    'شورای امروز: چند عامل مستقل و بی‌نام پاسخ می‌دهند و رئیس پاسخ را می‌نویسد.',
  'flow.template.writer-critics.hint':
    'یک عامل با ابزارهایش پیش‌نویس می‌نویسد. منتقدان بی‌نام دربارهٔ آن پاسخ می‌دهند. عامل دوم آن را به پاسخ بازنویسی می‌کند.',

  // ---------- the page ----------
  'flow.designBadge': 'طرح',
  'flow.councilBadge': 'شورا',
  'flow.levelNote':
    'طرح در «پایه» ویرایش می‌شود. اینجا فقط برای سطح «{level}» می‌توانید مدل و استدلال یک عامل را عوض کنید یا خاموشش کنید.',

  // ---------- the canvas ----------
  'flow.canvas': 'بوم طرح',
  'flow.palette': 'افزودن',
  'flow.palette.agent': 'عامل',
  'flow.palette.member': 'عضو',
  'flow.palette.writer': 'نویسنده',
  'flow.palette.writerHint':
    'نویسنده برای رئیس یک گزارش پیش‌نویس می‌نویسد. عضو شورا نیست، پس شورا به طرح تبدیل می‌شود.',
  'flow.palette.fullMembers': 'یک شورا حداکثر {max} عضو دارد.',
  'flow.palette.input': 'ورودی',
  'flow.palette.output': 'خروجی',
  'flow.palette.there': 'از قبل هست',
  'flow.palette.full': 'یک طرح حداکثر {max} جعبه دارد.',
  'flow.fit': 'جا دادن همهٔ طرح در نما',
  'flow.arrange': 'چیدن جعبه‌ها',
  'flow.input.kind': 'ورودی',
  'flow.input.name': 'پرسش شما',
  'flow.input.sub': 'و گفت‌وگو تا اینجا',
  'flow.output.kind': 'خروجی',
  'flow.output.name': 'پاسخ',
  'flow.output.sub': 'پیشنهاد و پرسش‌ها',
  'flow.form.report': 'گزارش',
  'flow.form.member': 'پاسخ عضو',
  'flow.form.answer': 'پاسخ نهایی',
  'flow.role.member': 'عضو',
  'flow.role.writer': 'نویسنده',
  'flow.role.critic': 'منتقد',
  'flow.role.chairman': 'رئیس',
  'flow.role.rewriter': 'بازنویس',
  'flow.shortage': '{n} مدل عضو دیگر لازم است',
  'flow.group': 'دست‌کم {min} از {of} · بی‌نام',
  'flow.required': 'پیش‌نویس · لازم',
  'flow.readOnly': 'فقط‌خواندنی',
  'flow.offAtLevel': 'در سطح «{level}» خاموش',
  'flow.changedHere': 'برای این سطح تغییر کرده',
  'flow.off': 'خاموش',
  'flow.switchedOff': 'خاموش',

  // ---------- the inspector ----------
  'flow.inspector': 'بازرس',
  'flow.empty.title': 'یک عامل را انتخاب کنید',
  'flow.empty.text': 'مدل، دسترسی و پرامپتش همین‌جا ویرایش می‌شود.',
  'flow.agentLine.report': 'عامل · گزارش می‌نویسد',
  'flow.agentLine.member': 'عامل · مثل یک عضو پاسخ می‌دهد',
  'flow.agentLine.answer': 'عامل · پاسخ نهایی را می‌دهد',
  'flow.name': 'نام',
  'flow.name.placeholder': 'نام این عامل',
  'flow.receives': 'دریافت می‌کند',
  'flow.receives.context': 'گفت‌وگو تا اینجا',
  'flow.receives.contextNote': 'خودکار فرستاده می‌شود',
  'flow.receives.question': 'پرسش شما',
  'flow.receives.questionNote': 'از ورودی',
  'flow.receives.draft': 'پیش‌نویس از «{name}»',
  'flow.receives.draftNote': 'لازم',
  'flow.group.title': { one: 'پاسخ از {count} عامل', other: 'پاسخ از {count} عامل' },
  'flow.group.use': 'دست‌کم',
  'flow.group.of': 'از {n}',
  'flow.group.fewer': 'منتظر پاسخ‌های کمتر بماند',
  'flow.group.more': 'منتظر پاسخ‌های بیشتر بماند',
  'flow.group.anonymous': 'نویسندهٔ هر پاسخ پنهان است: حرف‌ها هر دور دوباره جابه‌جا می‌شوند.',
  'flow.group.rule':
    'وقتی همه تمام کردند شروع می‌شود، یا وقتی دست‌کم {min} پاسخ آمده و بقیه هم تمام کرده‌اند.',
  'flow.runsOn': 'اجرا با',
  'flow.access': 'دسترسی',
  'flow.access.readonly': 'فقط‌خواندنی · هرگز نمی‌نویسد',
  'flow.access.webFinal': 'وب برای عاملی که پاسخ نهایی را می‌دهد بسته است.',
  'flow.outputForm': 'شکل خروجی',
  'flow.formHint.report': 'یادداشت آزاد به‌صورت Markdown، برای اینکه عامل بعدی بخواند.',
  'flow.formHint.member': 'پاسخ کوتاه و ساخت‌یافته: موضع، پیشنهاد، ادعاها و خطرها.',
  'flow.formHint.answer':
    'پاسخی که می‌گیرید: عنوان، پیشنهاد و پرسش‌ها. فقط همین شکل می‌تواند به خروجی برسد.',
  'flow.formFeedsOutput': 'این عامل به خروجی می‌رسد، پس شکلش باید «پاسخ نهایی» باشد.',
  'flow.prompt': 'پرامپت سیستم',
  'flow.prompt.undo': 'برگرداندن تغییرهای پرامپت',
  'flow.deleteAgent': 'حذف این عامل',
  'flow.base.takesPart': 'شرکت می‌کند',
  'flow.base.off':
    'خاموش است: اینجا می‌ماند ولی از آن پرسیده نمی‌شود. یک سطح می‌تواند دوباره روشنش کند.',
  'flow.level.title': 'در سطح «{level}»',
  'flow.level.takesPart': 'در این سطح شرکت می‌کند',
  'flow.level.off': 'در این سطح خاموش است؛ طرح همچنان آن را دارد.',
  'flow.level.fixed': 'بقیهٔ تنظیم‌های این عامل در «پایه» است.',
  'flow.level.alwaysOn': 'عاملی که پاسخ نهایی را می‌دهد همیشه شرکت می‌کند.',
  'flow.level.derived': 'استدلال را سطح می‌گذارد؛ اینجا فقط برای همین عامل عوضش می‌کنید.',
  'flow.inputInfo':
    'جایی که هر دور شروع می‌شود: پرسشی که می‌پرسید. عامل‌هایی که عامل دیگری به آن‌ها نمی‌رسد آن را از اینجا می‌گیرند؛ هر عامل گفت‌وگو تا اینجا را هم می‌خواند.',
  'flow.outputInfo':
    'آنچه می‌گیرید: پاسخ همان یک عاملی که پاسخ نهایی را می‌دهد، با عنوان، پیشنهاد و پرسش‌هایش.',
  'flow.edge.title': 'اتصال',
  'flow.edge.ends': '{from} به {to}',
  'flow.edge.input': 'پرسش شما را برای «{to}» می‌فرستد.',
  'flow.edge.required': '«{to}» پیش از شروع به این پیش‌نویس نیاز دارد.',
  'flow.edge.group': 'یکی از پاسخ‌هایی که «{to}» منتظرشان است.',
  'flow.edge.output': 'پاسخ را می‌رساند.',
  'flow.edge.delete': 'حذف اتصال',

  // ---------- a council on the canvas ----------
  'flow.council.note':
    'کشیدن خط بین جعبه‌ها یا افزودن نویسنده، این شورا را به طرح تبدیل می‌کند. هر تغییر دیگر اینجا آن را شورا نگه می‌دارد.',
  'flow.council.noteQuick':
    'مدل سریع به سرعت دستیارهای شما بستگی دارد، پس به طرح تبدیل نمی‌شود. برای ساختن طرح آن را تکثیر کنید.',
  'flow.council.noEffort': 'شورای پایه استدلال جدا ندارد: هر سطح استدلال آن را می‌گذارد.',
  'flow.council.defaultMember': 'یکی از اعضای پیش‌فرض دیوان. برای کنار گذاشتنش خاموشش کنید.',
  'flow.council.minimum': 'شورا منتظر دو پاسخ می‌ماند. هر عدد دیگر آن را به طرح تبدیل می‌کند.',
  'flow.council.formTitle': 'شکل و پرامپت',
  'flow.council.form':
    'هر عضو از شکل پاسخ و پرامپت سیستم استاندارد دیوان استفاده می‌کند و رئیس از مال خودش. برای عوض کردنشان، این شورا را طرح کنید.',
  'flow.council.makeDesign': 'تبدیل به طرح…',
  'flow.council.quickCannot': 'مدل سریع به طرح تبدیل نمی‌شود. برای ساختن طرح آن را تکثیر کنید.',
  'flow.convert.title': 'این شورا طرح شود؟',
  'flow.convert.text':
    'این شورا به یک طرح تبدیل می‌شود. در سطح «{level}» طرح همهٔ گام‌هایش را نگه می‌دارد و فقط استدلال‌ها را کم می‌کند؛ شورا کندترین عضو را خاموش می‌کند.',
  'flow.convert.limits':
    'محدودیت پاسخ این شورا ({claims} ادعا برای هر عضو، {words} کلمه در هر ادعا) جایش را به شکل استاندارد پاسخ عضو می‌دهد.',
  'flow.convert.saved':
    'تا دکمهٔ ذخیره را نزنید چیزی ذخیره نمی‌شود. «دور ریختن تغییرها» شورا را برمی‌گرداند.',
  'flow.convert.continue': 'ادامه',

  // ---------- settings of the whole council ----------
  'flow.settings.open': 'تنظیم‌های این مدل',
  'flow.settings.title': 'تنظیم‌های مدل',
  'flow.settings.titleDesign': 'تنظیم‌های طرح',
  'flow.settings.purposeDesign':
    'عامل‌ها، خط‌ها و پرامپت‌هایی که وقتی با این طرح می‌پرسید پاسخ می‌دهند.',
  'flow.settings.assistants': 'دستیارهای این رایانه',
  'flow.settings.allUsable': 'همهٔ دستیارهایی که دیوان می‌شناسد روی این رایانه در دسترس‌اند.',
  'flow.settings.resetHintDesign':
    'طرح را برمی‌دارد و همهٔ تغییرهای ذخیره‌شده را پاک می‌کند، در پایه و در همهٔ سطح‌ها. مدل به ساختار خودکار شورا برمی‌گردد.',
  'flow.settings.resetTextDesign':
    '«{name}» دیگر طرح نیست: عامل‌ها، خط‌ها و پرامپت‌هایش و همهٔ تغییرهای سطح‌ها پاک می‌شود و به تنظیم‌های خودکار شورا برمی‌گردد. این کار برگشت ندارد.',

  // ---------- checks ----------
  'flow.valid': 'طرح درست است',
  'flow.problem.title': 'نیاز به رسیدگی',
  'flow.problem.show': 'نشان بده',
  'flow.fixToSave': 'برای ذخیره، طرح را درست کنید.',
  'flow.problem.format': 'طرح خوانده نمی‌شود.',
  'flow.problem.size': 'یک طرح 3 تا 18 جعبه و حداکثر 80 خط دارد.',
  'flow.problem.id': 'شناسهٔ «{name}» مجاز نیست یا دو بار آمده است.',
  'flow.problem.kind': '«{name}» جعبه‌ای نیست که طرح داشته باشد.',
  'flow.problem.oneIO': 'یک طرح دقیقاً یک ورودی و یک خروجی دارد.',
  'flow.problem.edge': 'یک خط به جعبه‌ای می‌رود که نیست، یا خط دیگری را تکرار می‌کند.',
  'flow.problem.connection': 'از خروجی چیزی بیرون نمی‌رود و به ورودی چیزی نمی‌رسد.',
  'flow.problem.lost':
    '«{name}» وصل نیست: باید از ورودی راهی به آن باشد و راهی از آن به خروجی برسد.',
  'flow.problem.lostMany': {
    one: '«{name}» و {count} جعبهٔ دیگر وصل نیستند: هرکدام باید از ورودی راهی به آن باشد و راهی از آن به خروجی برسد.',
    other:
      '«{name}» و {count} جعبهٔ دیگر وصل نیستند: هرکدام باید از ورودی راهی به آن باشد و راهی از آن به خروجی برسد.',
  },
  'flow.problem.cycle':
    'این عامل‌ها در یک حلقه به هم می‌رسند: {names}. بازنویسی یک عامل دوم است، نه خطی به عقب.',
  'flow.problem.final':
    'دقیقاً یک عامل پاسخ نهایی را می‌دهد و خروجی پاسخ همان عامل را می‌گیرد. شکلش را «پاسخ نهایی» بگذارید و به خروجی وصلش کنید.',
  'flow.problem.finalWeb': '«{name}» پاسخ نهایی را می‌دهد، پس کلید وبش باید خاموش بماند.',
  'flow.problem.model': 'برای «{name}» یک مدل انتخاب کنید.',
  'flow.problem.prompt': '«{name}» پرامپت سیستم لازم دارد.',
  'flow.problem.agent': '«{name}» تنظیمی دارد که نیست یا مجاز نیست.',
  'flow.problem.role': 'نقش «{name}» با شکل خروجی‌اش نمی‌خواند.',
  'flow.problem.size.agent': 'پرامپت «{name}» بیش از حد بلند است (حداکثر 64,000 نویسه).',
  'flow.problem.dependency': 'آنچه به «{name}» می‌رسد با خط‌هایش نمی‌خواند. خط‌ها را دوباره بکشید.',
  'flow.problem.minimum': '«{name}» منتظر پاسخ‌های بیشتری است تا عامل‌هایی که به آن می‌رسند.',
  'flow.problem.disabled': '«{name}» به عاملی نیاز دارد که خاموش است.',
  'flow.problem.critic':
    '«{name}» پیش‌نویس می‌خواند، پس فقط یک عامل گزارش‌نویس می‌تواند آن را به این شکل بدهد.',
  'flow.problem.disabledOutput': 'عاملی که پاسخ نهایی را می‌دهد نمی‌تواند خاموش باشد.',
  'flow.problem.access': '«{name}»: {reason}',
  'flow.problem.atLevel': 'در سطح «{level}»: {problem}',

  // ---------- a line that is refused ----------
  'flow.refused.self': 'یک جعبه نمی‌تواند به خودش برسد.',
  'flow.refused.missing': 'این خط جایی ندارد که برود.',
  'flow.refused.fromOutput': 'خروجی پایان است: چیزی از آن بیرون نمی‌رود.',
  'flow.refused.toInput': 'ورودی آغاز است: چیزی به آن نمی‌رسد.',
  'flow.refused.duplicate': 'این دو جعبه از قبل به هم وصل‌اند.',
  'flow.refused.outputNeedsAnswer':
    'فقط عاملی که پاسخ نهایی را می‌دهد می‌تواند به خروجی برسد. اول شکلش را «پاسخ نهایی» بگذارید.',
  'flow.refused.outputTaken': 'خروجی از قبل پاسخش را از عامل دیگری می‌گیرد. اول آن خط را حذف کنید.',
  'flow.refused.inputRedundant':
    'هر عامل پرسش شما و گفت‌وگو را از قبل می‌خواند؛ عاملی که عامل‌های دیگر به آن می‌رسند خط از ورودی لازم ندارد.',
  'flow.refused.answerFeedsAgent':
    'پاسخ نهایی طرح را تمام می‌کند: فقط خروجی می‌تواند آن را بگیرد. بازنویسی یک عامل دوم است.',
  'flow.refused.cycle':
    'این خط حلقه می‌سازد: طرح فقط رو به جلو اجرا می‌شود. بازنویسی یک عامل دوم است.',
  'flow.refused.dismiss': 'بستن',
};
