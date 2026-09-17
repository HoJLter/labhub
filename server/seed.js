// Заполнение БД демо-данными (идемпотентно; --force пересоздаёт контент).
// Генерирует НАСТОЯЩИЕ файлы: многостраничные PDF с кириллицей, валидные DOCX (OOXML zip),
// PNG-постеры, а также правдоподобную статистику за 60 дней для дашборда.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';
import { db, get, all, run, tx, now, audit, setSetting } from './db.js';
import { generatePdf } from './pdfgen.js';
import { generatePng } from './pnggen.js';
import { makeZip } from './zipstore.js';
import { ensureAdminUser } from './auth.js';
import { KIND_BY_EXT, MIME_BY_EXT } from './sources.js';

// ——— Генерация DOCX (минимальный валидный OOXML) ———
function generateDocx(title, paragraphs) {
  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const body = paragraphs.map(p =>
    p.startsWith('# ')
      ? `<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:rPr><w:b/><w:sz w:val="32"/></w:rPr><w:t>${esc(p.slice(2))}</w:t></w:r></w:p>`
      : `<w:p><w:r><w:t xml:space="preserve">${esc(p)}</w:t></w:r></w:p>`
  ).join('');
  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr></w:body></w:document>`;
  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`;
  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;
  return makeZip([
    { name: '[Content_Types].xml', data: Buffer.from(contentTypes, 'utf8') },
    { name: '_rels/.rels', data: Buffer.from(rels, 'utf8') },
    { name: 'word/document.xml', data: Buffer.from(documentXml, 'utf8') },
  ]);
}

// ——— Тексты для генерации PDF ———
function labPages(num, topic, subject, sections) {
  const pages = [{
    title: `Лабораторная работа №${num}`,
    lines: [
      `## ${topic}`,
      '',
      `Дисциплина: ${subject}`,
      'Кафедра информационных технологий',
      '',
      '## Цель работы',
      sections[0].goal,
      '',
      '## Задачи',
      ...sections[0].tasks.map(t => `- ${t}`),
    ],
  }];
  for (let i = 0; i < sections.length; i++) {
    const s = sections[i];
    pages.push({
      title: `${s.heading}`,
      lines: [
        ...s.paragraphs.flatMap(p => [p, '']),
        ...(s.bullets ? ['## Ключевые моменты', ...s.bullets.map(b => `- ${b}`)] : []),
      ],
    });
  }
  pages.push({
    title: 'Задание и порядок выполнения',
    lines: [
      '## Задание',
      `Выполните лабораторную работу №${num} по теме «${topic}» в соответствии с вариантом.`,
      'Вариант определяется по последней цифре номера студента в групповом списке.',
      '',
      '## Порядок выполнения',
      '- Изучите теоретическую часть (разделы выше).',
      '- Разработайте программу согласно вашему варианту.',
      '- Протестируйте программу на приведённых примерах.',
      '- Подготовьте отчёт: титульный лист, листинг кода, скриншоты работы, ответы на контрольные вопросы.',
      '- Защитите работу преподавателю, ответив на контрольные вопросы.',
      '',
      '## Требования к отчёту',
      'Отчёт оформляется в формате PDF или DOCX и загружается в систему дистанционного обучения до даты дедлайна. Объём отчёта — не более 15 страниц.',
    ],
  });
  pages.push({
    title: 'Контрольные вопросы',
    lines: [
      '## Контрольные вопросы',
      ...sections.flatMap(s => s.questions || []).map(q => `- ${q}`),
      '',
      '## Список литературы',
      '- Основная литература по дисциплине (см. рабочую программу).',
      '- Документация и официальные спецификации.',
      '- Материалы лекционного курса.',
    ],
  });
  return pages;
}

const CONTENT = {
  oop1: () => labPages(1, 'Классы и объекты', 'Объектно-ориентированное программирование', [
    { heading: 'Теория: основы ООП', goal: 'Изучить базовые понятия объектно-ориентированного программирования: класс, объект, поле, метод, конструктор.',
      tasks: ['Освоить объявление классов и создание объектов', 'Изучить инкапсуляцию и модификаторы доступа', 'Реализовать класс с конструктором и методами'],
      paragraphs: [
        'Объектно-ориентированное программирование (ООП) — парадигма, в которой программа представляется как совокупность взаимодействующих объектов, каждый из которых является экземпляром определённого класса.',
        'Класс описывает структуру и поведение объектов: поля хранят состояние, методы определяют операции. Конструктор инициализирует новый экземпляр класса.',
        'Инкапсуляция — сокрытие внутренней реализации и предоставление доступа через публичный интерфейс. Модификаторы доступа (public, protected, private) управляют видимостью членов класса.',
      ],
      bullets: ['Класс — шаблон, объект — экземпляр', 'Состояние хранится в полях, поведение — в методах', 'Инвариант класса должен поддерживаться всегда'],
      questions: ['Что такое класс и чем он отличается от объекта?', 'Назначение конструктора и деструктора?', 'Какие модификаторы доступа вы знаете?'] },
    { heading: 'Практика: проектирование классов', goal: '',
      tasks: [],
      paragraphs: [
        'При проектировании класса сначала определяют его ответственность (принцип единственной ответственности, SRP). Класс должен иметь одну причину для изменения.',
        'Поля объявляются приватными, доступ — через геттеры и сеттеры с валидацией. Это позволяет изменять внутреннюю реализацию, не ломая клиентский код.',
        'Пример: класс BankAccount с приватным полем balance и методом withdraw, проверяющим достаточность средств, гарантирует неотрицательность баланса.',
      ],
      questions: ['Что такое инвариант класса?', 'Почему поля рекомендуется делать приватными?', 'Как обеспечить валидацию при изменении состояния?'] },
  ]),
  oop2: () => labPages(2, 'Наследование и полиморфизм', 'Объектно-ориентированное программирование', [
    { heading: 'Теория: наследование', goal: 'Изучить механизмы наследования и полиморфизма, принципы подстановки.',
      tasks: ['Создать иерархию классов с базовым и производными', 'Переопределить методы и использовать виртуальную диспетчеризацию', 'Применить абстрактные классы и интерфейсы'],
      paragraphs: [
        'Наследование позволяет создавать новый класс на основе существующего, перенимая его поля и методы. Производный класс расширяет или изменяет поведение базового.',
        'Полиморфизм — возможность работать с объектами разных типов через общий интерфейс. Виртуальные методы вызываются в зависимости от фактического типа объекта во время выполнения (позднее связывание).',
        'Принцип подстановки Барбары Лисков: объекты базового типа должны быть заменяемы объектами производных типов без нарушения корректности программы.',
      ],
      bullets: ['is-a отношение: Наследование моделирует отношение «является»', 'Переопределение (override) меняет поведение метода в подклассе', 'Абстрактный класс не имеет экземпляров'],
      questions: ['Чем переопределение отличается от перегрузки?', 'Сформулируйте принцип подстановки Лисков', 'Когда использовать композицию вместо наследования?'] },
    { heading: 'Практика: иерархия фигур', goal: '',
      tasks: [],
      paragraphs: [
        'Классический пример полиморфизма — иерархия геометрических фигур: абстрактный базовый класс Shape с методами area() и perimeter(), производные Circle, Rectangle, Triangle.',
        'Клиентский код работает со списком List<Shape> и вызывает area() у каждого элемента — конкретная реализация выбирается динамически.',
        'Добавление новой фигуры не требует изменения клиентского кода — это проявление принципа открытости/закрытости (OCP из SOLID).',
      ],
      questions: ['Как реализовать иерархию фигур?', 'Что такое позднее связывание?', 'Как OCP связан с полиморфизмом?'] },
  ]),
  oop3: () => labPages(3, 'Интерфейсы, исключения и шаблоны проектирования', 'Объектно-ориентированное программирование', [
    { heading: 'Теория: интерфейсы', goal: 'Освоить интерфейсы, обработку исключений и базовые шаблоны проектирования.',
      tasks: ['Реализовать классы от нескольких интерфейсов', 'Построить иерархию исключений', 'Применить паттерны Factory и Strategy'],
      paragraphs: [
        'Интерфейс описывает контракт поведения без реализации. Класс может реализовывать несколько интерфейсов, что решает проблему множественного наследования.',
        'Исключения — механизм сигнализирования об ошибках. Иерархия исключений разделяет проверяемые (checked) и непроверяемые (unchecked). Блок try/catch/finally гарантирует освобождение ресурсов.',
        'Шаблоны проектирования — проверенные решения типичных задач. Factory Method инкапсулирует создание объектов, Strategy выносит алгоритмы в отдельные классы.',
      ],
      bullets: ['Интерфейс ≠ класс: только контракт', 'Не глотайте исключения молча', 'Паттерн решает типовую задачу, а не заменяет проектирование'],
      questions: ['Зачем нужны интерфейсы, если есть абстрактные классы?', 'Чем checked-исключения отличаются от unchecked?', 'Опишите паттерн Strategy'] },
  ]),
  web1: () => labPages(1, 'Основы HTML и CSS', 'Веб-технологии', [
    { heading: 'Теория: HTML', goal: 'Изучить структуру HTML-документа, семантическую разметку и основы CSS.',
      tasks: ['Сверстать статическую страницу с семантической разметкой', 'Применить flexbox и grid для раскладки', 'Сделать адаптивную вёрстку (media queries)'],
      paragraphs: [
        'HTML (HyperText Markup Language) — язык разметки документов. Современные требования — семантическая разметка: header, nav, main, article, section, footer вместо бессмысленных div.',
        'CSS (Cascading Style Sheets) описывает представление: селекторы, каскад, специфичность, наследование. Flexbox предназначен для одномерных раскладок, Grid — для двумерных.',
        'Адаптивность достигается media queries, относительными единицами (rem, %, vw/vh) и принципом mobile-first: стили для малых экранов — базовые.',
      ],
      bullets: ['Семантика важна для доступности и SEO', 'BEM-методология предотвращает конфликты имён', 'Проверяйте вёрстку валидатором W3C'],
      questions: ['Какие семантические теги HTML5 вы знаете?', 'В чём разница между flexbox и grid?', 'Как работает специфичность селекторов?'] },
  ]),
  web2: () => labPages(2, 'JavaScript и работа с DOM', 'Веб-технологии', [
    { heading: 'Теория: DOM', goal: 'Изучить модель документов DOM, события и асинхронный JavaScript.',
      tasks: ['Реализовать интерактивный интерфейс на чистом JS', 'Выполнить запрос к REST API через fetch', 'Обработать события и делегирование'],
      paragraphs: [
        'DOM (Document Object Model) — программное представление HTML-документа в виде дерева узлов. JavaScript изменяет структуру, атрибуты и стили через DOM API.',
        'События распространяются в фазах capture и bubble. Делегирование — обработка событий многих элементов одним слушателем на общем предке.',
        'Асинхронность: Promise, async/await, fetch API. Event loop обеспечивает неблокирующее выполнение: тяжёлые операции не останавливают отрисовку интерфейса.',
      ],
      bullets: ['querySelector быстрее читается, getElementById быстрее работает', 'Избегайте layout thrashing: группируйте чтения и записи DOM', 'fetch возвращает промис, ошибки сети — в catch'],
      questions: ['Что такое делегирование событий?', 'Чем async/await отличается от .then()?', 'Как браузер обрабатывает event loop?'] },
  ]),
  math1: () => labPages(1, 'Пределы и непрерывность', 'Математический анализ', [
    { heading: 'Теория: пределы', goal: 'Освоить определение предела функции, замечательные пределы, непрерывность.',
      tasks: ['Вычислить пределы различными методами', 'Исследовать функции на непрерывность', 'Найти точки разрыва и их классификацию'],
      paragraphs: [
        'Предел функции в точке — значение, к которому стремится f(x) при приближении аргумента к данной точке. Формальное определение — на языке эпсилон-дельта (по Коши).',
        'Первый замечательный предел: lim(x→0) sin(x)/x = 1. Второй замечательный предел: lim(x→∞) (1 + 1/x)^x = e.',
        'Функция непрерывна в точке, если предел значения функции равен значению функции в этой точке. Точки разрыва делятся на первого рода (устранимый, скачок) и второго рода.',
      ],
      bullets: ['Правило Лопиталя применяется к неопределённостям 0/0 и ∞/∞', 'Эквивалентные бесконечно малые ускоряют вычисления', 'Проверяйте односторонние пределы'],
      questions: ['Дайте определение предела по Коши', 'Сформулируйте замечательные пределы', 'Какие бывают точки разрыва?'] },
  ]),
  math2: () => labPages(2, 'Производные и их применение', 'Математический анализ', [
    { heading: 'Теория: производная', goal: 'Изучить понятие производной, правила дифференцирования, геометрический смысл.',
      tasks: ['Найти производные сложных функций', 'Исследовать функцию и построить график', 'Решить задачи на оптимизацию'],
      paragraphs: [
        'Производная — предел отношения приращения функции к приращению аргумента. Геометрически — угловой коэффициент касательной, физически — скорость изменения величины.',
        'Правила: производная суммы, произведения (Лейбниц), частного, сложной функции (цепное правило). Таблица производных основных функций обязательна к запоминанию.',
        'Применение: исследование функции на монотонность и экстремумы, выпуклость и точки перегиба, асимптоты. Задачи оптимизации сводятся к поиску экстремумов.',
      ],
      bullets: ['f\'(x0) = 0 — необходимое условие экстремума', 'Вторая производная определяет выпуклость', 'Правило Лопиталя раскрывает неопределённости'],
      questions: ['В чём геометрический смысл производной?', 'Как найти точки экстремума?', 'Сформулируйте правило дифференцирования композиции'] },
  ]),
  db1: () => labPages(1, 'Основы SQL', 'Базы данных', [
    { heading: 'Теория: реляционные БД', goal: 'Изучить основы реляционной модели и языка SQL (выборки, соединения, агрегация).',
      tasks: ['Спроектировать схему БД по описанию предметной области', 'Написать запросы SELECT с JOIN и GROUP BY', 'Создать индексы и проанализировать планы запросов'],
      paragraphs: [
        'Реляционная модель: данные — таблицы (отношения), строки — кортежи, столбцы — атрибуты с доменами. Ключи: первичный (PK), внешний (FK), уникальность и ссылочная целостность.',
        'SQL — декларативный язык запросов. SELECT ... FROM ... WHERE ... GROUP BY ... HAVING ... ORDER BY — порядок логической обработки отличается от порядка написания.',
        'JOIN-ы: INNER (пересечение), LEFT/RIGHT (с сохранением одной стороны), FULL, CROSS. Нормализация (1НФ–3НФ) устраняет избыточность и аномалии обновления.',
      ],
      bullets: ['Индекс ускоряет SELECT, замедляет INSERT/UPDATE', 'EXPLAIN показывает план выполнения', 'Транзакции: ACID, уровни изоляции'],
      questions: ['Какие виды JOIN вы знаете?', 'Что такое нормальные формы?', 'Как работают индексы B-Tree?'] },
  ]),
  os1: () => labPages(1, 'Работа в Linux и системные вызовы', 'Операционные системы', [
    { heading: 'Теория: ОС и процессы', goal: 'Изучить архитектуру ОС, управление процессами, файловые системы и командную оболочку Linux.',
      tasks: ['Освоить базовые команды shell (ls, cd, grep, pipe)', 'Написать shell-скрипт автоматизации', 'Изучить управление процессами (ps, kill, nice)'],
      paragraphs: [
        'Операционная система — прослойка между аппаратурой и приложениями. Ядро управляет процессами, памятью, устройствами и файлами. Системные вызовы — интерфейс пользовательского пространства с ядром.',
        'Процесс — экземпляр выполняемой программы: PID, состояние, адресное пространство, дескрипторы файлов. Поток — единица выполнения внутри процесса. Планировщик распределяет CPU по квантам времени.',
        'Файловая система Unix: всё есть файл. Иерархия от корня /, права доступа (rwx для owner/group/others), inode хранит метаданные. Ссылки: жёсткие (hard) и символические (soft).',
      ],
      bullets: ['man — встроенная документация', 'Конвейеры (|) комбинируют утилиты', 'systemd управляет службами: systemctl'],
      questions: ['Чем процесс отличается от потока?', 'Что такое inode?', 'Как устроены права доступа к файлам?'] },
  ]),
};

// ——— Основной сид ———
export function seed({ force = false } = {}) {
  ensureAdminUser();

  const existing = get('SELECT COUNT(*) AS c FROM folders')?.c ?? 0;
  if (existing > 0 && !force) return { seeded: false };

  if (force) {
    tx(() => {
      for (const t of ['material_tags', 'link_health', 'events', 'daily_stats', 'search_queries', 'materials', 'tags', 'folders']) {
        run(`DELETE FROM ${t}`);
      }
    });
  }

  // Хранилище по умолчанию — локальный диск
  if (!get('SELECT id FROM storages LIMIT 1')) {
    run("INSERT INTO storages(name, type, config, is_default, health_status, last_check_at) VALUES('Локальный диск','local',?,1,'ok',?)",
      JSON.stringify({ dir: config.paths.files }), now());
  }
  const localStorageId = get('SELECT id FROM storages WHERE is_default = 1').id;

  const tagIds = {};
  for (const t of ['1 семестр', '2 семестр', '3 семестр', 'лабораторная', 'практическая', 'методичка', 'лекция', 'видео', 'SQL', 'Linux']) {
    run('INSERT OR IGNORE INTO tags(name) VALUES(?)', t);
    tagIds[t] = get('SELECT id FROM tags WHERE name = ?', t).id;
  }

  // ——— Папки ———
  const mk = (parent, slug, title, description, icon, color, position) => {
    run('INSERT INTO folders(parent_id, slug, title, description, icon, color, position, visibility, default_storage_id, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
      parent, slug, title, description, icon, color, position, 'listed', localStorageId, now(), now());
    return get('SELECT id FROM folders WHERE slug = ?', slug).id;
  };
  const fOop = mk(null, 'oop', 'ООП', 'Объектно-ориентированное программирование: классы, наследование, паттерны проектирования', 'code', '#5b5bd6', 0);
  const fOopLabs = mk(fOop, 'oop-labs', 'Лабораторные работы', 'Лабораторные работы по ООП, варианты заданий и методические указания', 'flask', '#5b5bd6', 0);
  const fOopPrac = mk(fOop, 'oop-practice', 'Практические работы', 'Практикум: разбор задач и код-ревью', 'pen', '#5b5bd6', 1);
  const fWeb = mk(null, 'web', 'Веб-технологии', 'HTML, CSS, JavaScript, работа с DOM и REST API', 'globe', '#0ea5a5', 1);
  const fWebLabs = mk(fWeb, 'web-labs', 'Лабораторные работы', 'Лабораторные по веб-разработке', 'flask', '#0ea5a5', 0);
  const fMath = mk(null, 'math', 'Математический анализ', 'Пределы, производные, интегралы — лекции и задачники', 'sigma', '#d97706', 2);
  const fDb = mk(null, 'db', 'Базы данных', 'Реляционные СУБД, SQL, проектирование схем', 'database', '#16a34a', 3);
  const fOs = mk(null, 'os', 'Операционные системы', 'Linux, процессы, память, файловые системы', 'terminal', '#dc2626', 4);

  // ——— Материалы ———
  function saveFile(name, buf) {
    const p = path.join(config.paths.files, name);
    fs.writeFileSync(p, buf);
    return p;
  }
  function material(folderId, slug, title, description, opts) {
    const t = now();
    run(`INSERT INTO materials(folder_id, slug, title, description, kind, mime, size, source_type, source_config, storage_id,
        checksum, page_count, duration_sec, poster_path, file_path, converted_path, convert_status, status, visibility,
        allow_download, noindex, views_count, reads_count, downloads_count, published_at, created_at, updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      folderId, slug, title, description, opts.kind, opts.mime || '', opts.size || 0, opts.source_type || 'local',
      JSON.stringify(opts.source_config || {}), opts.storage_id ?? localStorageId, opts.checksum || null,
      opts.page_count ?? null, opts.duration_sec ?? null, opts.poster_path || null, opts.file_path || null,
      opts.converted_path || null, opts.convert_status || 'none', opts.status || 'published', opts.visibility || 'listed',
      opts.allow_download ?? 1, opts.noindex ?? 0, 0, 0, 0, opts.published_at ?? t, t, t);
    const id = get('SELECT id FROM materials WHERE slug = ?', slug).id;
    for (const tagName of opts.tags || []) {
      run('INSERT OR IGNORE INTO material_tags(material_id, tag_id) VALUES(?,?)', id, tagIds[tagName]);
    }
    return id;
  }

  function addPdf(folderId, slug, title, description, pagesFn, tags, publishedAt, accent) {
    const pages = pagesFn();
    const buf = generatePdf(pages, { subject: title, accent });
    const fileName = `${slug}.pdf`;
    const p = saveFile(fileName, buf);
    return material(folderId, slug, title, description, {
      kind: 'pdf', mime: 'application/pdf', size: buf.length, file_path: p,
      checksum: crypto.createHash('sha256').update(buf).digest('hex'),
      page_count: pages.length, tags, published_at: publishedAt,
    });
  }

  const day = 86400000;
  const t0 = now();

  // ООП
  addPdf(fOopLabs, 'oop-lab-1', 'Лабораторная №1. Классы и объекты',
    'Первая лабораторная: объявление классов, конструкторы, инкапсуляция. Задания по вариантам, контрольные вопросы, требования к отчёту.',
    CONTENT.oop1, ['1 семестр', 'лабораторная'], t0 - 52 * day, [0.36, 0.36, 0.84]);
  addPdf(fOopLabs, 'oop-lab-2', 'Лабораторная №2. Наследование и полиморфизм',
    'Иерархии классов, виртуальные методы, принцип подстановки Лисков. Практика: иерархия геометрических фигур.',
    CONTENT.oop2, ['1 семестр', 'лабораторная'], t0 - 44 * day, [0.36, 0.36, 0.84]);
  addPdf(fOopLabs, 'oop-lab-3', 'Лабораторная №3. Интерфейсы и шаблоны проектирования',
    'Интерфейсы, исключения, паттерны Factory и Strategy. Порядок выполнения и защита работы.',
    CONTENT.oop3, ['2 семестр', 'лабораторная'], t0 - 30 * day, [0.36, 0.36, 0.84]);
  // Методичка DOCX
  {
    const buf = generateDocx('Методические указания по ООП', [
      '# Методические указания по дисциплине «Объектно-ориентированное программирование»',
      'Настоящие методические указания содержат рекомендации по выполнению и оформлению лабораторных работ для студентов 2 курса направления «Программная инженерия».',
      '# Общие требования',
      'Каждая лабораторная работа выполняется индивидуально или в составе бригады до двух человек. Срок выполнения — две недели с момента выдачи задания.',
      'Отчёт по работе оформляется в электронном виде (PDF или DOCX) и загружается в настоящее хранилище либо в LMS вуза.',
      '# Структура отчёта',
      'Титульный лист; постановка задачи; описание хода работы с листингами кода; результаты тестирования (скриншоты); выводы по работе; ответы на контрольные вопросы.',
      '# Критерии оценивания',
      'Корректность решения — до 50 баллов; качество кода (именование, структура, отсутствие дублирования) — до 20 баллов; полнота отчёта — до 15 баллов; защита работы (ответы на вопросы) — до 15 баллов.',
    ]);
    const p = saveFile('oop-methodichka.docx', buf);
    material(fOopPrac, 'oop-guide', 'Методичка по ООП',
      'Полные методические указания: требования к отчётам, структура, критерии оценивания. Формат DOCX — просмотр в браузере или скачивание.', {
      kind: 'docx', mime: MIME_BY_EXT.docx, size: buf.length, file_path: p,
      checksum: crypto.createHash('sha256').update(buf).digest('hex'),
      tags: ['методичка', '1 семестр', '2 семестр'], published_at: t0 - 50 * day,
      convert_status: 'none',
    });
  }
  // Практическая работа (PDF)
  {
    const pages = labPages(1, 'Практикум: диаграммы классов', 'ООП', [
      { heading: 'UML-диаграммы классов', goal: 'Научиться читать и строить диаграммы классов UML.', tasks: ['Построить диаграмму по описанию предметной области', 'Определить кратности связей', 'Реализовать диаграмму в коде'],
        paragraphs: ['Диаграмма классов — статическая структура системы: классы, их атрибуты, операции и связи (ассоциация, агрегация, композиция, наследование).', 'Кратность связи показывает, сколько объектов участвует в связи: 1, 0..1, *, 1..*.', 'Композиция — строгая форма агрегации: время жизни части совпадает со временем жизни целого.'],
        bullets: ['Агрегация — «имеет», композиция — «состоит из»', 'Наследование — сплошная линия с пустым треугольником', 'Зависимость — пунктирная стрелка'], questions: ['Чем агрегация отличается от композиции?', 'Что показывает кратность связи?'] },
    ]);
    const buf = generatePdf(pages, { subject: 'Практическая №1 по ООП' });
    const p = saveFile('oop-practice-1.pdf', buf);
    material(fOopPrac, 'oop-practice-1', 'Практическая №1. Разбор задач ООП',
      'Практическое занятие: разбор типовых задач на классы, диаграммы классов UML, код-ревью.', {
      kind: 'pdf', mime: 'application/pdf', size: buf.length, file_path: p,
      checksum: crypto.createHash('sha256').update(buf).digest('hex'),
      page_count: pages.length, tags: ['практическая', '1 семестр'], published_at: t0 - 48 * day,
    });
  }

  // ВЕБ
  addPdf(fWebLabs, 'web-lab-1', 'Лабораторная №1. HTML и CSS',
    'Семантическая вёрстка, flexbox/grid, адаптивность. Задание: сверстать страницу-портфолио.',
    CONTENT.web1, ['2 семестр', 'лабораторная'], t0 - 40 * day, [0.05, 0.65, 0.65]);
  addPdf(fWebLabs, 'web-lab-2', 'Лабораторная №2. JavaScript и DOM',
    'Работа с DOM, события, fetch API. Задание: интерактивный список задач с сохранением в localStorage.',
    CONTENT.web2, ['2 семестр', 'лабораторная'], t0 - 25 * day, [0.05, 0.65, 0.65]);

  // Матанализ
  addPdf(fMath, 'math-limits', 'Лекция 1. Пределы и непрерывность',
    'Определение предела по Коши, замечательные пределы, классификация точек разрыва.',
    CONTENT.math1, ['1 семестр', 'лекция'], t0 - 58 * day, [0.85, 0.47, 0.02]);
  addPdf(fMath, 'math-derivatives', 'Лекция 2. Производные',
    'Правила дифференцирования, геометрический смысл, исследование функций, оптимизация.',
    CONTENT.math2, ['1 семестр', 'лекция'], t0 - 51 * day, [0.85, 0.47, 0.02]);

  // Базы данных
  addPdf(fDb, 'db-lab-1', 'Лабораторная №1. Основы SQL',
    'SELECT, JOIN, GROUP BY, подзапросы, индексы. Задание: спроектировать и наполнить схему «Университет».',
    CONTENT.db1, ['3 семестр', 'лабораторная', 'SQL'], t0 - 20 * day, [0.09, 0.64, 0.29]);
  // Видео: внешний источник (url → proxy/redirect), реальный MP4
  {
    const videoUrl = 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4';
    const posterBuf = generatePng({ width: 640, height: 360, color: [0.09, 0.64, 0.29], play: true, seed: 7 });
    const posterPath = path.join(config.paths.posters, 'db-video-1.png');
    fs.writeFileSync(posterPath, posterBuf);
    material(fDb, 'db-video-normalization', 'Видеолекция: нормализация баз данных',
      'Запись лекции о нормальных формах (1НФ–3НФ) на практическом примере. Видео отдаётся из внешнего источника с поддержкой перемотки (Range).', {
      kind: 'video', mime: 'video/mp4', size: 158_008_374, source_type: 'url',
      source_config: { url: videoUrl, mode: 'redirect', cache: false },
      storage_id: null, duration_sec: 596, poster_path: posterPath,
      tags: ['3 семестр', 'видео', 'SQL'], published_at: t0 - 18 * day,
    });
  }
  // Изображение: ER-диаграмма
  {
    const buf = generatePng({ width: 1200, height: 800, color: [0.09, 0.64, 0.29], seed: 21 });
    const p = saveFile('db-er-diagram.png', buf);
    material(fDb, 'db-er-diagram', 'Схема ER-диаграммы «Университет»',
      'Демонстрационная ER-диаграмма для лабораторной №1: сущности Студент, Группа, Дисциплина, Преподаватель и связи между ними.', {
      kind: 'image', mime: 'image/png', size: buf.length, file_path: p,
      checksum: crypto.createHash('sha256').update(buf).digest('hex'),
      tags: ['3 семестр', 'SQL'], published_at: t0 - 17 * day,
    });
  }
  // Embed-видео (YouTube)
  material(fWeb, 'web-solid-video', 'Видео: SOLID простым языком (YouTube)',
    'Внешний видеоматериал — воспроизводится встроенным плеером источника (режим embed, нулевая нагрузка на сервер).', {
    kind: 'video', mime: 'text/html', source_type: 'embed', storage_id: null,
    source_config: { url: 'https://www.youtube.com/watch?v=rtmFCcjEgEw', mode: 'embed' },
    duration_sec: 852, tags: ['видео', '2 семестр'], published_at: t0 - 12 * day,
  });

  // Операционные системы
  addPdf(fOs, 'os-lab-1', 'Лабораторная №1. Linux и системные вызовы',
    'Командная оболочка, права доступа, процессы. Задание: написать shell-скрипт автоматизации.',
    CONTENT.os1, ['3 семестр', 'лабораторная', 'Linux'], t0 - 10 * day, [0.86, 0.15, 0.15]);
  // unlisted-материал (доступ по прямой ссылке)
  addPdf(fOs, 'os-cheatsheet', 'Шпаргалка: команды Linux (unlisted)',
    'Краткая справка по командам shell. Материал не индексируется и не отображается в каталоге — доступен только по прямой ссылке.',
    () => labPages(0, 'Справочник команд Linux', 'Операционные системы', [
      { heading: 'Файлы и каталоги', goal: '', tasks: [], paragraphs: ['ls -la — список с правами; cd — смена каталога; pwd — текущий путь; cp/mv/rm — копирование/перемещение/удаление; mkdir -p — создание дерева каталогов; find / -name — поиск файлов; du -sh — размер каталога.'], questions: [] },
      { heading: 'Текст и процессы', goal: '', tasks: [], paragraphs: ['grep -r — поиск по содержимому; cat/less/head/tail — просмотр; wc -l — число строк; sort/uniq — обработка; ps aux — процессы; top/htop — монитор; kill -9 — завершить; df -h — диски.'], questions: [] },
    ]),
    ['Linux', 'методичка'], t0 - 6 * day, [0.86, 0.15, 0.15]);
  run("UPDATE materials SET visibility = 'unlisted' WHERE slug = 'os-cheatsheet'");

  // Черновик (private) — виден только админу
  material(fOopLabs, 'oop-lab-4-draft', 'Лабораторная №4 (черновик)',
    'Служебный черновик следующей лабораторной — демонстрирует видимость private: доступен только в админ-панели.', {
    kind: 'link', mime: 'text/plain', source_type: 'url', status: 'hidden', visibility: 'private',
    source_config: { url: 'https://example.com/draft.pdf', mode: 'redirect' }, storage_id: null,
    tags: [], published_at: null,
  });

  // ——— Статистика за 60 дней (агрегаты + counters) ———
  seedStats();

  audit('system', 'seed.demo', 'materials', null, {});
  console.log(`[lab-hub] демо-данные созданы: ${get('SELECT COUNT(*) c FROM materials').c} материалов, ${get('SELECT COUNT(*) c FROM folders').c} папок`);
  return { seeded: true };
}

function seedStats() {
  const materials = all("SELECT id, kind, folder_id FROM materials WHERE status = 'published' AND visibility = 'listed'");
  const rndState = { s: 20260225 };
  const rnd = () => { rndState.s = (rndState.s * 16807) % 2147483647; return rndState.s / 2147483647; };
  const weights = materials.map((m, i) => 0.5 + rnd() * (m.kind === 'pdf' ? 2 : 1.4) + (i < 3 ? 0.8 : 0));

  for (let d = 60; d >= 0; d--) {
    const ts = now() - d * 86400000;
    const day = new Date(ts).toISOString().slice(0, 10);
    const dow = new Date(ts).getDay();
    const weekend = (dow === 0 || dow === 6) ? 0.45 : 1;
    // сессионная волна: рост активности в последние ~2 недели
    const surge = d < 14 ? 1.9 : d < 28 ? 1.2 : 1;
    const basePv = Math.round((45 + rnd() * 70) * weekend * surge);
    const uv = Math.round(basePv * (0.38 + rnd() * 0.12));
    const sessions = Math.round(uv * (1.05 + rnd() * 0.25));
    ins(day, 'pv', 'all', basePv);
    ins(day, 'uv', 'all', uv);
    ins(day, 'sessions', 'all', sessions);
    ins(day, 'time_sum', 'all', Math.round(sessions * (180 + rnd() * 300)));
    ins(day, 'time_n', 'all', sessions);
    // устройства / источники
    const mob = Math.round(basePv * (0.42 + rnd() * 0.1));
    ins(day, 'device', 'mobile', mob);
    ins(day, 'device', 'desktop', basePv - mob - Math.round(basePv * 0.06));
    ins(day, 'device', 'tablet', Math.round(basePv * 0.06));
    ins(day, 'referrer', 'direct', Math.round(sessions * 0.5));
    ins(day, 'referrer', 't.me', Math.round(sessions * 0.28));
    ins(day, 'referrer', 'vk.com', Math.round(sessions * 0.14));
    ins(day, 'search', 'all', Math.round(sessions * (0.3 + rnd() * 0.2)));

    // просмотры по материалам
    const totalW = weights.reduce((a, b) => a + b, 0);
    for (let i = 0; i < materials.length; i++) {
      const m = materials[i];
      const views = Math.round(basePv * 0.5 * (weights[i] / totalW) * (0.6 + rnd() * 0.8));
      if (views <= 0) continue;
      ins(day, 'material_view', String(m.id), views);
      const reads = Math.round(views * (0.45 + rnd() * 0.35));
      ins(day, 'reader_open', String(m.id), reads);
      const dl = Math.round(views * (0.08 + rnd() * 0.15));
      ins(day, 'download', String(m.id), dl);
      if (m.kind === 'video') {
        ins(day, 'video_25', String(m.id), Math.round(reads * 0.8));
        ins(day, 'video_50', String(m.id), Math.round(reads * 0.6));
        ins(day, 'video_75', String(m.id), Math.round(reads * 0.42));
        ins(day, 'video_100', String(m.id), Math.round(reads * 0.25));
      } else {
        ins(day, 'max_page_sum', String(m.id), reads * (2 + Math.round(rnd() * 5)));
        ins(day, 'max_page_n', String(m.id), reads);
      }
      run('UPDATE materials SET views_count = views_count + ?, reads_count = reads_count + ?, downloads_count = downloads_count + ? WHERE id = ?',
        views, reads, dl, m.id);
    }
  }
  // поисковые запросы
  const queries = [
    ['лабораторная ооп', 3], ['наследование', 2], ['sql join', 2], ['методичка', 4],
    ['пределы', 2], ['linux команды', 2], ['javascript dom', 2], ['uml', 1],
    ['курсовая', 0], ['экзамен математика', 0], ['haskell', 0],
  ];
  for (let i = 0; i < 140; i++) {
    const [q, rc] = queries[Math.floor(rndS() * queries.length)];
    run('INSERT INTO search_queries(query, results_count, created_at) VALUES(?,?,?)',
      q, rc, now() - Math.floor(rndS() * 60) * 86400000);
  }
}
let _s = 987654321;
function rndS() { _s = (_s * 16807) % 2147483647; return _s / 2147483647; }

function ins(day, metric, dim, value) {
  run(`INSERT INTO daily_stats(day, metric, dim, value) VALUES(?,?,?,?)
       ON CONFLICT(day, metric, dim) DO UPDATE SET value = value + excluded.value`, day, metric, dim, value);
}

// Запуск вручную: node server/seed.js [--force]
if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('server/seed.js')) {
  seed({ force: process.argv.includes('--force') });
}
