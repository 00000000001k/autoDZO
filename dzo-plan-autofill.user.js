// ==UserScript==
// @name         DZO.com.ua — автозаповнення плану закупівлі
// @namespace    dzo-plan-autofill
// @version      0.1.0
// @description  Автозаповнення повторюваних полів у формі "Редагування запису в річному плані закупівель" на dzo.com.ua з даних договору
// @match        https://www.dzo.com.ua/plans/*/edit*
// @match        https://www.dzo.com.ua/plans/*/create*
// @run-at       document-idle
// @grant        unsafeWindow
// @grant        GM_addStyle
// ==/UserScript==

/*
  ЧТО ЭТОТ СКРИПТ ДЕЛАЕТ АВТОМАТИЧЕСКИ (проверено по HTML-разметке страницы):
    1. Тип процедури -> "Закупівля без використання електронної системи"
    2. Очікувана вартість
    3. Конкретна назва предмету закупівлі (если вписать в панель)
    4. Тиснет "ДОДАТИ ДЖЕРЕЛО ФІНАНСУВАННЯ" и заповнює постійні поля:
       - Тип джерела фінансування: Місцевий бюджет
       - Сума (та сама, що й очікувана вартість)
       - Країна: Україна
       - Класифікатор ТПКВКМБ: 5061
       - Категорія КАТОТТГ: Місто
       - КАТОТТГ: пошук "Черкаси" (очікує варіант UA71080490010015879)
       - Область: Черкаська область
       - Населений пункт: м. Черкаси
       - Вулиця: вул. Пастерівська, 102
       - Індекс: 18003

  ЧТО СКРИПТ НЕ ТРОГАЕТ (сознательно, как и договаривались):
    - Рік планування
    - Валюта
    - Класифікація за ДК 021 / ДКПП / КЕКВ / ДК003 (це окремі спливаючі вікна
      пошуку класифікаторів, їх логіку узгодимо окремо — id полів у коді
      позначені як TODO)
    - Дата "Орієнтовний початок проведення процедури" — обирається вручну
      через календар (лише 1-ше число місяця)
    - Кнопка "Опублікувати" — публікацію завжди робимо руками, після
      перевірки

  ВАЖНО:
    Поля "Класифікатор ТПКВКМБ", "Категорія КАТОТТГ" та "Область" на сайті
    подгружаются через AJAX уже ПОСЛЕ того как выбран тип джерела
    фінансування "Місцевий бюджет" — скрипт это ждёт (до 8 секунд на каждое
    поле). Поиск по КАТОТТГ — это текстовое поле с автопідказками, самая
    хрупкая часть автоматизации: если подсказки на странице устроены не так,
    как я предположил по статической разметке, скрипт подсвітить поле
    жовтим і попросить обрати варіант вручну — решту полів це не зламає.
*/

(function () {
  'use strict';

  const $ = (typeof unsafeWindow !== 'undefined' && unsafeWindow.jQuery) ? unsafeWindow.jQuery : (window.jQuery || null);

  const CONST = {
    planMethodValue: 'limited_reporting',
    breakdownTitleValue: 'local',
    country: 'Україна',
    tpkvkmb: '5061',
    katottgCategoryText: 'Місто',
    katottgSearchText: 'Черкаси',
    katottgExpectedId: 'UA71080490010015879',
    region: 'Черкаська область',
    locality: 'м. Черкаси',
    street: 'вул. Пастерівська, 102',
    postalCode: '18003'
  };

  // ---------- маленькі допоміжні функції ----------

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function waitFor(conditionFn, timeoutMs = 8000, intervalMs = 150) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const result = conditionFn();
      if (result) return result;
      await sleep(intervalMs);
    }
    return null;
  }

  function fire(el, type) {
    el.dispatchEvent(new Event(type, { bubbles: true }));
  }

  function setInputValue(el, value) {
    if (!el) return false;
    el.value = value;
    fire(el, 'input');
    fire(el, 'change');
    fire(el, 'blur');
    return true;
  }

  function refreshChosen(selectEl) {
    if ($ && $(selectEl).data && $(selectEl).data('chosen')) {
      $(selectEl).trigger('chosen:updated');
    }
  }

  function setSelectValue(selectEl, value) {
    if (!selectEl) return false;
    selectEl.value = value;
    fire(selectEl, 'change');
    refreshChosen(selectEl);
    return selectEl.value === value;
  }

  async function waitForOptions(selectEl, timeoutMs = 8000) {
    return waitFor(() => selectEl && selectEl.options && selectEl.options.length > 1, timeoutMs);
  }

  function findOptionMatch(selectEl, { value, textIncludes }) {
    const options = Array.from(selectEl.options);
    if (value !== undefined) {
      const byValue = options.find((o) => o.value === value);
      if (byValue) return byValue;
    }
    if (textIncludes) {
      const needle = textIncludes.trim().toLowerCase();
      const byText = options.find((o) => o.textContent.trim().toLowerCase() === needle);
      if (byText) return byText;
      const byPartial = options.find((o) => o.textContent.trim().toLowerCase().includes(needle));
      if (byPartial) return byPartial;
    }
    return null;
  }

  async function selectByValueOrText(selectEl, matcher, label) {
    const ready = await waitForOptions(selectEl);
    if (!ready) {
      log(`⚠ Не дочекався варіантів для поля "${label}" — заповніть вручну.`);
      highlight(selectEl);
      return false;
    }
    const opt = findOptionMatch(selectEl, matcher);
    if (!opt) {
      log(`⚠ Не знайшов потрібний варіант у "${label}" — оберіть вручну.`);
      highlight(selectEl);
      return false;
    }
    setSelectValue(selectEl, opt.value);
    log(`✓ ${label}: ${opt.textContent.trim()}`);
    return true;
  }

  function highlight(el) {
    if (!el) return;
    el.style.outline = '3px solid #e6a800';
    el.style.outlineOffset = '2px';
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  // ---------- лог у панелі ----------

  let logBox;
  function log(msg) {
    console.log('[dzo-autofill]', msg);
    if (logBox) {
      const line = document.createElement('div');
      line.textContent = msg;
      logBox.appendChild(line);
      logBox.scrollTop = logBox.scrollHeight;
    }
  }

  // ---------- основний сценарій ----------

  async function fillMainFields(data) {
    const planMethodSelect = document.querySelector('select[name="plan_method"]');
    if (setSelectValue(planMethodSelect, CONST.planMethodValue)) {
      log('✓ Тип процедури: Закупівля без використання електронної системи');
    } else {
      log('⚠ Не знайшов поле "Тип процедури"');
    }

    const amountInput = document.querySelector('input[name="data[budget][amount]"]');
    if (setInputValue(amountInput, data.amount)) {
      log(`✓ Очікувана вартість: ${data.amount}`);
    } else {
      log('⚠ Не знайшов поле "Очікувана вартість"');
    }

    if (data.itemName) {
      // Це поле "Конкретна назва предмету закупівлі" під вкладками УКРАЇНСЬКА/IN ENGLISH —
      // фактично data[budget][description] (а не data[items][0][description], яке
      // стосується окремої позиції товару і зʼявляється лише після додавання специфікації).
      const nameInput = document.querySelector('input[name="data[budget][description]"]');
      if (setInputValue(nameInput, data.itemName)) {
        log(`✓ Конкретна назва предмету закупівлі заповнена`);
      } else {
        log('⚠ Не знайшов поле "Конкретна назва предмету закупівлі"');
      }
    }
  }

  async function addFundingSource(data) {
    const addLink = document.querySelector('#multiBreakdowns a.addMultiItem');
    if (!addLink) {
      log('⚠ Не знайшов посилання "ДОДАТИ ДЖЕРЕЛО ФІНАНСУВАННЯ"');
      return;
    }
    const listContainer = document.querySelector('#multiBreakdowns .listItems');
    const before = listContainer ? listContainer.children.length : 0;
    addLink.click();
    log('… натиснув "ДОДАТИ ДЖЕРЕЛО ФІНАНСУВАННЯ"');

    const added = await waitFor(() => listContainer && listContainer.children.length > before, 5000);
    if (!added) {
      log('⚠ Новий блок джерела фінансування не з’явився — заповніть вручну.');
      return;
    }
    // працюємо з останнім доданим блоком
    const block = listContainer.lastElementChild;

    const titleSelect = block.querySelector('select[name*="[title]"]');
    if (setSelectValue(titleSelect, CONST.breakdownTitleValue)) {
      log('✓ Тип джерела фінансування: Місцевий бюджет');
    }

    // даємо сайту час показати приховані рядки (Країна/ТПКВКМБ/КАТОТТГ/область/…)
    await sleep(400);

    const sumInput = block.querySelector('input[name*="[value][amount]"]');
    setInputValue(sumInput, data.amount);
    log(`✓ Сума джерела фінансування: ${data.amount}`);

    const countrySelect = block.querySelector('select[name*="[address][countryName]"]');
    setSelectValue(countrySelect, CONST.country);
    log('✓ Країна: Україна');

    const tpkvkmbSelect = block.querySelector('select[name*="[classification_tkpkmb_id]"]');
    await selectByValueOrText(tpkvkmbSelect, { value: CONST.tpkvkmb, textIncludes: CONST.tpkvkmb }, 'Класифікатор ТПКВКМБ');

    const katottgCategorySelect = block.querySelector('select[name*="[breakdown_katottg_categories]"]');
    await selectByValueOrText(katottgCategorySelect, { textIncludes: CONST.katottgCategoryText }, 'Категорія КАТОТТГ');

    await sleep(300);

    const regionSelect = block.querySelector('select[name*="[address][region]"]');
    await selectByValueOrText(regionSelect, { textIncludes: CONST.region }, 'Область');

    await fillKatottgSearch(block);

    const localityInput = block.querySelector('input[name*="[address][locality]"]');
    setInputValue(localityInput, CONST.locality);
    log('✓ Населений пункт: ' + CONST.locality);

    const streetInput = block.querySelector('input[name*="[address][streetAddress]"]');
    setInputValue(streetInput, CONST.street);
    log('✓ Вулиця: ' + CONST.street);

    const postalInput = block.querySelector('input[name*="[address][postalCode]"]');
    setInputValue(postalInput, CONST.postalCode);
    log('✓ Індекс: ' + CONST.postalCode);
  }

  // Найбільш крихка частина: текстове поле з автопідказками КАТОТТГ.
  // Пробуємо ввести текст, почекати на список підказок і клікнути потрібну.
  async function fillKatottgSearch(block) {
    const input = block.querySelector('input.categoriesSearch, input[id^="breakdown_katottg"]');
    if (!input) {
      log('⚠ Не знайшов поле пошуку КАТОТТГ — оберіть населений пункт вручну.');
      return;
    }
    const beforeCount = document.querySelectorAll('li, .autocomplete-item, .ui-menu-item').length;
    setInputValue(input, CONST.katottgSearchText);
    fire(input, 'keyup');
    fire(input, 'keydown');

    const suggestion = await waitFor(() => {
      const candidates = Array.from(document.querySelectorAll('li, .autocomplete-item, .ui-menu-item, [class*="suggest"]'));
      return candidates.find((el) => el.textContent && el.textContent.includes(CONST.katottgSearchText) && el.offsetParent !== null) || null;
    }, 3000);

    if (suggestion) {
      suggestion.click();
      log('✓ КАТОТТГ: обрано варіант зі списку підказок (перевірте, що це саме ' + CONST.katottgExpectedId + ')');
    } else {
      log('⚠ Список підказок КАТОТТГ не знайдено автоматично — впишіть "' + CONST.katottgSearchText + '" і оберіть варіант ' + CONST.katottgExpectedId + ' вручну.');
      highlight(input);
    }
  }

  // ---------- класифікатор (ДК021 / КЕКВ і т.п. — спливаюче вікно з iframe + jsTree) ----------

  // idPrefix — латинська частина id вузлів дерева (для ДК021 це "DK021"; для інших
  // класифікаторів поки не перевірено — з'ясуємо, коли дійдемо до КЕКВ).
  async function fillClassificationField({ dataClass, idPrefix, code, label }) {
    if (!code) return;
    const link = document.querySelector(`a.choiceClass[data-class="${dataClass}"]`);
    if (!link) {
      log(`⚠ Не знайшов посилання "Визначити за довідником" для "${label}"`);
      return;
    }

    const before = document.querySelectorAll('div.info iframe').length;
    link.click();
    log(`… відкриваю довідник "${label}"`);

    const iframe = await waitFor(() => {
      const frames = Array.from(document.querySelectorAll('div.info iframe'));
      return frames.length > before ? frames[frames.length - 1] : null;
    }, 5000);
    if (!iframe) {
      log(`⚠ Вікно довідника "${label}" не з'явилось — оберіть код вручну.`);
      return;
    }

    const iframeDoc = await waitFor(() => {
      try {
        const d = iframe.contentDocument;
        return d && d.getElementById('search') ? d : null;
      } catch (e) {
        return null;
      }
    }, 6000);
    if (!iframeDoc) {
      log(`⚠ Не зміг зазирнути у вікно довідника "${label}" — оберіть код вручну.`);
      return;
    }

    const searchInput = iframeDoc.getElementById('search');
    searchInput.value = code;
    ['keydown', 'keyup', 'input', 'change'].forEach((t) => fire(searchInput, t));
    log(`… шукаю код "${code}" у довіднику "${label}"`);

    const nodeId = 'cl_' + idPrefix + '_' + code.replace(/-/g, '_');
    const node = await waitFor(() => iframeDoc.getElementById(nodeId), 5000);
    if (!node) {
      log(`⚠ Не знайшов код "${code}" у списку "${label}" (перевірте id-префікс "${idPrefix}") — оберіть вручну.`);
      return;
    }
    const anchor = node.querySelector('a') || node;
    anchor.click();
    log(`✓ Обрано у "${label}": ${code}`);

    await sleep(300);

    const chooseBtn = iframeDoc.getElementById('select')
      || Array.from(iframeDoc.querySelectorAll('button, a, input[type="button"], input[type="submit"]'))
        .find((b) => (b.textContent || b.value || '').trim() === 'Вибрати');
    if (chooseBtn) {
      chooseBtn.click();
      log(`✓ Підтверджено вибір у "${label}"`);
    } else {
      log(`⚠ Не знайшов кнопку "Вибрати" у "${label}" — підтвердіть вручну.`);
    }
  }

  async function runAll(data) {
    logBox.innerHTML = '';
    log('Починаю автозаповнення…');
    await fillMainFields(data);
    if (data.dk021) {
      await fillClassificationField({
        dataClass: 'ДК021',
        idPrefix: 'DK021',
        code: data.dk021,
        label: 'Класифікація за ДК 021-2015 (CPV)'
      });
    }
    if (data.kekv) {
      await fillClassificationField({
        dataClass: 'КЕКВ',
        idPrefix: 'KEKV',
        code: data.kekv,
        label: 'Код КЕКВ'
      });
    }
    await addFundingSource(data);
    log('Готово. Перевірте дату початку процедури і КАТОТТГ — і тисніть "Опублікувати" вручну.');
  }

  // ---------- панель керування ----------

  function buildPanel() {
    GM_addStyle(`
      #dzo-autofill-panel {
        position: fixed;
        top: 90px;
        right: 16px;
        width: 300px;
        background: #fff;
        border: 1px solid #ccc;
        border-radius: 8px;
        box-shadow: 0 4px 18px rgba(0,0,0,.2);
        z-index: 999999;
        font: 13px/1.4 Arial, sans-serif;
        color: #222;
      }
      #dzo-autofill-panel h4 {
        margin: 0; padding: 8px 10px; background: #f2f2f2;
        border-bottom: 1px solid #ddd; font-size: 13px; cursor: move;
      }
      #dzo-autofill-panel .body { padding: 10px; }
      #dzo-autofill-panel label { display: block; margin-top: 8px; font-weight: bold; }
      #dzo-autofill-panel input {
        width: 100%; box-sizing: border-box; padding: 4px 6px; margin-top: 2px;
      }
      #dzo-autofill-panel button {
        margin-top: 10px; width: 100%; padding: 6px; cursor: pointer;
      }
      #dzo-autofill-panel .log {
        margin-top: 8px; max-height: 160px; overflow-y: auto;
        background: #fafafa; border: 1px solid #eee; padding: 4px 6px;
        font-size: 12px;
      }
      #dzo-autofill-panel .toggle {
        position: absolute; top: 6px; right: 8px; cursor: pointer; font-weight: bold;
      }
    `);

    const panel = document.createElement('div');
    panel.id = 'dzo-autofill-panel';
    panel.innerHTML = `
      <h4>Автозаповнення з договору <span class="toggle">—</span></h4>
      <div class="body">
        <label>Сума договору, грн (без ПДВ)</label>
        <input type="text" id="dzo-af-amount" placeholder="напр. 4800.00">
        <label>Назва предмету закупівлі (необов'язково)</label>
        <input type="text" id="dzo-af-itemname" placeholder="Футболка з нанесеним логотипом …">
        <label>Код ДК 021 (CPV), напр. 18330000-1</label>
        <input type="text" id="dzo-af-dk021" placeholder="18330000-1">
        <label>Код КЕКВ (2210 або 2240)</label>
        <input type="text" id="dzo-af-kekv" placeholder="2210">
        <button id="dzo-af-run">Заповнити форму</button>
        <div class="log" id="dzo-af-log"></div>
      </div>
    `;
    document.body.appendChild(panel);
    logBox = panel.querySelector('#dzo-af-log');

    const body = panel.querySelector('.body');
    const toggle = panel.querySelector('.toggle');
    toggle.addEventListener('click', () => {
      const collapsed = body.style.display === 'none';
      body.style.display = collapsed ? '' : 'none';
      toggle.textContent = collapsed ? '—' : '+';
    });

    panel.querySelector('#dzo-af-run').addEventListener('click', () => {
      const amountRaw = panel.querySelector('#dzo-af-amount').value.replace(',', '.').trim();
      const itemName = panel.querySelector('#dzo-af-itemname').value.trim();
      const dk021 = panel.querySelector('#dzo-af-dk021').value.trim();
      const kekv = panel.querySelector('#dzo-af-kekv').value.trim();
      if (!amountRaw) {
        alert('Вкажіть суму договору');
        return;
      }
      runAll({ amount: amountRaw, itemName, dk021, kekv });
    });
  }

  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    buildPanel();
  } else {
    document.addEventListener('DOMContentLoaded', buildPanel);
  }
})();
