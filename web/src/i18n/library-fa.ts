// متن صفحهٔ کتابخانه (پرامپت‌ها و شکل‌های خروجی) و آنچه سرور آنجا نمی‌پذیرد. با fa.ts یکی می‌شود. «عامل» همان جعبهٔ یک دستیار
// در طرح است؛ «دستیار» ابزار (Claude Code، Codex و …) است.

import type { Msg } from './index.tsx';
import type { libraryEn } from './library-en.ts';

export const libraryFa: Record<keyof typeof libraryEn, Msg> = {
  'nav.library': 'کتابخانه',
  'councils.goal.library': 'رفتن به کتابخانه',

  // ---------- the page ----------
  'library.tab.prompts': 'پرامپت‌ها',
  'library.tab.forms': 'شکل‌های خروجی',
  'library.intro':
    'پرامپت و شکل خروجی یک بار اینجا نوشته می‌شوند و هر مدلی می‌تواند از آن‌ها استفاده کند. ویرایش یکی از آن‌ها از همان لحظه روی همهٔ مدل‌هایی که از آن استفاده می‌کنند اثر می‌گذارد؛ سشنی که شروع شده همان چیزی را نگه می‌دارد که با آن شروع کرده بود.',
  'library.loadFailed': 'کتابخانه بارگذاری نشد.',
  'library.yours': 'مال شما',
  'library.builtin': 'آماده',
  'library.newPrompt': 'پرامپت تازه',
  'library.newForm': 'شکل خروجی تازه',
  'library.nonePrompts':
    'هنوز پرامپتی از خودتان ندارید. یکی بسازید یا یک پرامپت آماده را تکثیر کنید.',
  'library.noneForms':
    'هنوز شکل خروجی‌ای از خودتان ندارید. یکی بسازید یا شکل «گزارش» را تکثیر کنید.',
  'library.untitled': 'بدون نام',
  'library.notSaved': 'هنوز ذخیره نشده',
  'library.usedByCount': { one: 'در {count} مدل', other: 'در {count} مدل' },
  'library.fieldCount': { one: '{count} فیلد', other: '{count} فیلد' },
  'library.anyForm': 'هر شکلی',
  'library.inputs.any.short': 'هر ورودی',
  'library.inputs.with.short': 'با ورودی',
  'library.inputs.without.short': 'بدون ورودی',
  'library.inputs.any.label': 'هر دو',
  'library.inputs.with.label': 'با ورودی',
  'library.inputs.without.label': 'بدون ورودی',
  'library.inputs.any.hint': 'به عاملی می‌خورد، چه عامل‌های دیگر به آن برسند چه نرسند.',
  'library.inputs.with.hint':
    'برای عاملی نوشته شده که پاسخ عامل‌های دیگر به آن می‌رسد، مثل رئیس یا بازنویس.',
  'library.inputs.without.hint': 'برای عاملی نوشته شده که خودش تنها به پرسش پاسخ می‌دهد.',
  'library.emptyTitle': 'چیزی انتخاب نشده',
  'library.emptyPrompts': 'یک پرامپت را از فهرست انتخاب کنید تا بخوانیدش، یا یکی تازه بسازید.',
  'library.emptyForms': 'یک شکل خروجی را از فهرست انتخاب کنید تا بخوانیدش، یا یکی تازه بسازید.',
  'library.missingTitle': 'این مورد اینجا نیست',
  'library.missingText': 'شاید حذف شده باشد. یکی دیگر را از فهرست انتخاب کنید.',

  // ---------- an entry ----------
  'library.name': 'نام',
  'library.namePlaceholder': 'برای این مورد یک نام بنویسید',
  'library.nameEmpty': 'یک نام بنویسید.',
  'library.id': 'شناسه',
  'library.idHint': 'مدل‌ها این مورد را با این شناسه می‌شناسند:',
  'library.idBad':
    'شناسه با یک حرف کوچک لاتین شروع می‌شود و حرف، رقم، - و _ دارد (تا 48 نویسه). نمی‌تواند report، member یا answer باشد.',
  'library.idTaken': 'این شناسه قبلاً استفاده شده.',
  'library.idFixed': 'مدل‌ها این مورد را با این شناسه می‌شناسند؛ پس از ذخیره دیگر عوض نمی‌شود.',
  'library.create': 'بساز',
  'library.copyOf': 'نسخهٔ {name}',
  'library.newFromPrompt': 'پرامپت تازه از روی این',
  'library.newFromForm': 'شکل خروجی تازه از روی این',
  'library.newFromPromptText':
    'نسخه‌ای از «{name}» که می‌توانید ویرایشش کنید. نام و شناسهٔ خودش را دارد.',
  'library.newFromFormText':
    'نسخه‌ای از «{name}» که می‌توانید ویرایشش کنید. نام و شناسهٔ خودش را دارد.',
  'library.duplicate': 'تکثیر',
  'library.saveFirst': 'اول تغییرها را ذخیره کنید یا دور بریزید.',
  'library.builtinBadge': 'آماده · فقط‌خواندنی',
  'library.builtinNote': 'مورد آماده ویرایش نمی‌شود. برای تغییر، یک نسخه از آن بسازید (تکثیر).',
  'library.builtinFormNote':
    'شکل‌های «پاسخ عضو» و «پاسخ نهایی» فیلدهای تودرتو دارند که سازندهٔ فیلد نمی‌تواند نگه دارد، پس تکثیر نمی‌شوند. شکل «گزارش» تکثیر می‌شود.',
  'library.usedBy': 'استفاده‌شده در',
  'library.usedByNone': 'هنوز هیچ مدلی از آن استفاده نمی‌کند.',
  'library.formPrompts': 'پرامپت‌هایی که برای این شکل نوشته شده‌اند:',
  'library.prompt.divan.member': 'عضو',
  'library.prompt.divan.chairman': 'رئیس',
  'library.prompt.divan.direct': 'پاسخ مستقیم',
  'library.prompt.divan.report': 'نویسندهٔ گزارش',
  'library.prompt.divan.critic': 'منتقد',

  // ---------- a prompt ----------
  'library.promptForm': 'نوشته شده برای',
  'library.promptFormHint':
    'شکل خروجی‌ای که این پرامپت برایش است. انتخاب‌گرها آن را به عامل‌هایی با همان شکل نشان می‌دهند، و اگر «هر شکلی» باشد به هر عاملی.',
  'library.promptInputs': 'ورودی‌ها',
  'library.promptText': 'متن پرامپت',
  'library.promptPlaceholder': 'پرامپت را بنویسید…',
  'library.promptTextHint': 'کل متنی که به‌عنوان دستورش به عامل داده می‌شود.',
  'library.promptCustomHint':
    'برای شکل خروجی‌ای که خودتان ساخته‌اید، دیوان فهرست فیلدهایش را بعد از متن شما می‌افزاید.',

  // ---------- an output form ----------
  'library.fields': 'فیلدها',
  'library.fieldsHint':
    'دستیار باید دقیقاً با همین فیلدها پاسخ بدهد. فیلدی که لازم نیست می‌تواند خالی (null) بماند.',
  'library.field.add': 'افزودن فیلد',
  'library.field.remove': 'حذف این فیلد',
  'library.field.up': 'بردن به بالا',
  'library.field.down': 'بردن به پایین',
  'library.field.name': 'نام فیلد',
  'library.field.type': 'نوع',
  'library.field.required': 'لازم',
  'library.field.description': 'توضیح',
  'library.field.descriptionPlaceholder': 'این فیلد چه چیزی را نگه می‌دارد، برای دستیار',
  'library.field.maxWords': 'حد کلمه',
  'library.field.itemWords': 'کلمه در هر مورد',
  'library.field.min': 'کمترین',
  'library.field.max': 'بیشترین',
  'library.field.maxItems': 'بیشترین مورد',
  'library.field.options': 'گزینه‌ها، هر کدام در یک خط',
  'library.optionsPlaceholder': 'pass\nfail',
  'library.type.text': 'متن',
  'library.type.markdown': 'Markdown',
  'library.type.number': 'عدد',
  'library.type.boolean': 'بله / خیر',
  'library.type.choice': 'انتخابی',
  'library.type.list': 'فهرست',
  'library.type.string': 'متن',
  'library.type.integer': 'عدد صحیح',
  'library.type.array': 'فهرست',
  'library.type.object': 'فیلدهای تودرتو',
  'library.fieldProblem.name':
    'نام فیلد حرف کوچک لاتین، رقم و _ دارد، با یک حرف شروع می‌شود و تا 32 نویسه است.',
  'library.fieldProblem.duplicate': 'دو فیلد این نام را دارند.',
  'library.fieldProblem.description': 'توضیح بیش از حد بلند است (حداکثر 2,000 نویسه).',
  'library.fieldProblem.maxWords': 'حد کلمه یک عدد صحیح از 1 تا 8,000 است.',
  'library.fieldProblem.maxItems': 'بیشترین مورد یک عدد صحیح از 0 تا 100 است.',
  'library.fieldProblem.bounds': 'کمترین عدد از بیشترین بزرگ‌تر است، یا یک عدد بیش از حد بزرگ است.',
  'library.fieldProblem.options':
    'فیلد انتخابی از 1 تا 50 گزینهٔ متفاوت لازم دارد، هرکدام تا 200 نویسه.',
  'library.schema.title': 'JSON Schema‌ای که به دستیارها داده می‌شود',
  'library.schema.hint':
    'این همان چیزی است که سرور برای این شکل به دستیارها می‌دهد. حدهای کلمه، عدد و تعداد در آن نیست: دیوان خودش وقتی پاسخ برمی‌گردد بررسی‌شان می‌کند.',

  // ---------- saving and deleting ----------
  'library.blocker.name': 'برای ذخیره یک نام بنویسید.',
  'library.blocker.id': 'برای ذخیره شناسه را درست کنید.',
  'library.blocker.prompt': 'برای ذخیره متن پرامپت را بنویسید (حداکثر 64,000 نویسه).',
  'library.blocker.fields': 'برای ذخیره فیلدها را درست کنید.',
  'library.save': 'ذخیره',
  'library.saved':
    'ذخیره شد. مدل‌هایی که از آن استفاده می‌کنند از حالا تغییر را می‌گیرند؛ سشن‌هایی که شروع شده‌اند همان چیزی را نگه می‌دارند که با آن شروع کرده بودند.',
  'library.conflict': '«{name}» جای دیگری تغییر کرده. ویرایش‌های شما هنوز اینجاست.',
  'library.conflictLoad': 'بارگذاری نسخهٔ دیگر',
  'library.conflictKeep': 'نسخهٔ من بماند',
  'library.reloadTitle': 'نسخهٔ دیگر بارگذاری شود؟',
  'library.reloadText': 'ویرایش‌های شما در این مورد دور ریخته می‌شوند و برنمی‌گردند.',
  'library.deleteTitle': 'این مورد حذف شود؟',
  'library.deleteText': '«{name}» حذف می‌شود. این کار برگشت ندارد.',
  'library.inUse.title': 'این مورد در حال استفاده است',
  'library.inUse.text': 'تا وقتی چیزی از «{name}» استفاده می‌کند حذفش نمی‌شود کرد.',
  'library.inUse.models': 'مدل‌هایی که از آن استفاده می‌کنند',
  'library.inUse.prompts': 'پرامپت‌هایی که برای این شکل نوشته شده‌اند',
  'library.inUse.how': 'اول آن را از آن مدل‌ها بردارید (یا آن پرامپت‌ها را حذف کنید)، بعد حذفش کنید.',
  'library.inUse.close': 'بستن',
  'library.goal.new': 'شروع یک مورد تازه',

  // ---------- what the server refuses, in plain words ----------
  'library.reason.entry_id': 'شناسه مجاز نیست.',
  'library.reason.entry_name': 'نام خالی است یا از 100 نویسه بیشتر است.',
  'library.reason.entry_revision': 'نسخهٔ این مورد درست نیست.',
  'library.reason.prompt_form': 'شکل خروجی‌ای که این پرامپت برایش نوشته شده درست نیست.',
  'library.reason.prompt_inputs': 'تنظیم ورودی‌های این پرامپت درست نیست.',
  'library.reason.prompt_text': 'متن پرامپت خالی است یا از 64,000 نویسه بیشتر است.',
  'library.reason.prompt_form_missing':
    'شکل خروجی‌ای که این پرامپت برایش نوشته شده در کتابخانه نیست.',
  'library.reason.form_fields': 'یک شکل خروجی از 1 تا 30 فیلد دارد.',
  'library.reason.field_name':
    'نام یک فیلد مجاز نیست یا دو بار آمده: حرف کوچک لاتین، رقم و _ بنویسید و با یک حرف شروع کنید.',
  'library.reason.field_type': 'نوع یکی از فیلدها مجاز نیست.',
  'library.reason.field_description': 'یکی از توضیح‌ها از 2,000 نویسه بیشتر است.',
  'library.reason.field_limit': 'حد کلمه یا حد تعداد یکی از فیلدها بیرون از مقدار مجاز است.',
  'library.reason.field_bounds': 'کمترین عدد از بیشترین بزرگ‌تر است، یا یک عدد بیش از حد بزرگ است.',
  'library.reason.field_limit_type': 'یکی از فیلدها حدی دارد که نوعش اجازه نمی‌دهد.',
  'library.reason.field_options':
    'فیلد انتخابی از 1 تا 50 گزینهٔ متفاوت لازم دارد، هرکدام تا 200 نویسه.',
  'library.reason.form_size': 'این شکل خروجی بیش از حد بزرگ است.',
  'library.reason.builtin_form_not_flat':
    'این شکل آماده فیلدهای تودرتو (فهرست‌هایی از شیء) دارد که سازندهٔ فیلد نمی‌تواند نگه دارد، پس تکثیر نمی‌شود. یک شکل تازه بسازید و فیلدهایش را بیفزایید، یا شکل «گزارش» را تکثیر کنید.',
  'library.reason.other': 'سرور آن را نپذیرفت ({reason}).',
};
