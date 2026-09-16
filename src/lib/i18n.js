'use strict';

const LANGUAGES = [
  { code: 'en', name: 'English', native: 'English' },
  { code: 'hi', name: 'Hindi', native: 'हिन्दी' },
  { code: 'es', name: 'Spanish', native: 'Español' },
  { code: 'de', name: 'German', native: 'Deutsch' },
  { code: 'ar', name: 'Arabic', native: 'العربية' },
];

const RTL = new Set(['ar']);

const en = {
  // Navigation / chrome
  'nav.menu': 'Menu',
  'nav.dashboard': 'Dashboard',
  'nav.server': 'Server Management',
  'nav.overview': 'Overview',
  'nav.terminal': 'Terminal',
  'nav.files': 'File Manager',
  'nav.backups': 'Backups',
  'nav.schedules': 'Schedules',
  'nav.startup': 'Startup',
  'nav.settings': 'Settings',
  'nav.subusers': 'Subusers',
  'nav.activity': 'Activity',
  'nav.personal': 'Personalization',
  'nav.profile': 'Profile',
  'nav.billing': 'Billing',
  'nav.admin': 'Admin Dashboard',
  'nav.nodes': 'Nodes & Live Status',
  'nav.create': 'Create Server',
  'nav.users': 'User Management',
  'nav.plans': 'Billing & Plans',
  'nav.templates': 'OS Templates',
  'nav.storage': 'Storage & ISOs',
  'nav.network': 'Networks & Firewall',
  'nav.activityLog': 'Activity Log',
  'nav.updates': 'Updates Center',
  'nav.settingsMgmt': 'Settings Management',
  'nav.session': 'Session',
  'nav.logout': 'Logout',
  'topbar.search': 'Search servers...',
  'topbar.newServer': 'New Server',
  'topbar.impersonation': 'Impersonation session active',
  'topbar.returnAdmin': 'Return to Admin',
  // Common actions
  'common.back': 'Back',
  'common.save': 'Save',
  'common.cancel': 'Cancel',
  'common.delete': 'Delete',
  'common.create': 'Create',
  'common.refresh': 'Refresh',
  'common.close': 'Close',
  'common.ok': 'OK',
  'common.enable': 'Enable',
  'common.disable': 'Disable',
  'common.confirm': 'Confirm',
  'dashboard.title': 'Virtual Machines',
  'dashboard.empty': 'Deploy your first virtual machine to get started with instant cloud environments.',
  'dashboard.deployFirst': 'Deploy First Virtual Machine',
  'dashboard.createVm': 'Create Virtual Machine',
  'dashboard.shared': 'Shared Virtual Machines',
  'dashboard.newServer': 'New Server',
};

const dicts = { en, hi: {}, es: {}, de: {}, ar: {} };

// Hindi
dicts.hi = {
  'nav.menu': 'मेन्यू',
  'nav.dashboard': 'डैशबोर्ड',
  'nav.server': 'सर्वर प्रबंधन',
  'nav.overview': 'अवलोकन',
  'nav.terminal': 'टर्मिनल',
  'nav.files': 'फ़ाइल प्रबंधक',
  'nav.backups': 'बैकअप',
  'nav.schedules': 'शेड्यूल',
  'nav.startup': 'स्टार्टअप',
  'nav.settings': 'सेटिंग्स',
  'nav.subusers': 'उप-उपयोगकर्ता',
  'nav.activity': 'गतिविधि',
  'nav.personal': 'वैयक्तिकरण',
  'nav.profile': 'प्रोफ़ाइल',
  'nav.billing': 'बिलिंग',
  'nav.admin': 'एडमिन डैशबोर्ड',
  'nav.nodes': 'नोड्स एवं लाइव स्थिति',
  'nav.create': 'सर्वर बनाएँ',
  'nav.users': 'उपयोगकर्ता प्रबंधन',
  'nav.plans': 'बिलिंग एवं प्लान',
  'nav.templates': 'OS टेम्पलेट',
  'nav.storage': 'स्टोरेज एवं ISO',
  'nav.network': 'नेटवर्क एवं फ़ायरवॉल',
  'nav.activityLog': 'गतिविधि लॉग',
  'nav.updates': 'अपडेट केंद्र',
  'nav.settingsMgmt': 'सेटिंग्स प्रबंधन',
  'nav.session': 'सत्र',
  'nav.logout': 'लॉग आउट',
  'topbar.search': 'सर्वर खोजें...',
  'topbar.newServer': 'नया सर्वर',
  'topbar.impersonation': 'प्रतिरूपण सत्र सक्रिय है',
  'topbar.returnAdmin': 'एडमिन पर लौटें',
  'common.back': 'वापस',
  'common.save': 'सहेजें',
  'common.cancel': 'रद्द करें',
  'common.delete': 'हटाएँ',
  'common.create': 'बनाएँ',
  'common.refresh': 'रिफ़्रेश',
  'common.close': 'बंद करें',
  'common.ok': 'ठीक है',
  'common.enable': 'सक्षम',
  'common.disable': 'अक्षम',
  'common.confirm': 'पुष्टि करें',
  'dashboard.title': 'वर्चुअल मशीनें',
  'dashboard.empty': 'त्वरित क्लाउड वातावरण शुरू करने के लिए अपनी पहली वर्चुअल मशीन बनाएँ।',
  'dashboard.deployFirst': 'पहली वर्चुअल मशीन बनाएँ',
  'dashboard.createVm': 'वर्चुअल मशीन बनाएँ',
  'dashboard.shared': 'साझा वर्चुअल मशीनें',
  'dashboard.newServer': 'नया सर्वर',
};

// Spanish
dicts.es = {
  'nav.menu': 'Menú',
  'nav.dashboard': 'Panel',
  'nav.server': 'Gestión de servidores',
  'nav.overview': 'Resumen',
  'nav.terminal': 'Terminal',
  'nav.files': 'Gestor de archivos',
  'nav.backups': 'Copias de seguridad',
  'nav.schedules': 'Programaciones',
  'nav.startup': 'Inicio',
  'nav.settings': 'Ajustes',
  'nav.subusers': 'Subusuarios',
  'nav.activity': 'Actividad',
  'nav.personal': 'Personalización',
  'nav.profile': 'Perfil',
  'nav.billing': 'Facturación',
  'nav.admin': 'Panel de administración',
  'nav.nodes': 'Nodos y estado en vivo',
  'nav.create': 'Crear servidor',
  'nav.users': 'Gestión de usuarios',
  'nav.plans': 'Facturación y planes',
  'nav.templates': 'Plantillas de sistema',
  'nav.storage': 'Almacenamiento e ISOs',
  'nav.network': 'Redes y cortafuegos',
  'nav.activityLog': 'Registro de actividad',
  'nav.updates': 'Centro de actualizaciones',
  'nav.settingsMgmt': 'Gestión de ajustes',
  'nav.session': 'Sesión',
  'nav.logout': 'Cerrar sesión',
  'topbar.search': 'Buscar servidores...',
  'topbar.newServer': 'Nuevo servidor',
  'topbar.impersonation': 'Sesión de suplantación activa',
  'topbar.returnAdmin': 'Volver al administrador',
  'common.back': 'Atrás',
  'common.save': 'Guardar',
  'common.cancel': 'Cancelar',
  'common.delete': 'Eliminar',
  'common.create': 'Crear',
  'common.refresh': 'Actualizar',
  'common.close': 'Cerrar',
  'common.ok': 'Aceptar',
  'common.enable': 'Habilitar',
  'common.disable': 'Deshabilitar',
  'common.confirm': 'Confirmar',
  'dashboard.title': 'Máquinas virtuales',
  'dashboard.empty': 'Implementa tu primera máquina virtual para comenzar con entornos en la nube instantáneos.',
  'dashboard.deployFirst': 'Implementar primera máquina virtual',
  'dashboard.createVm': 'Crear máquina virtual',
  'dashboard.shared': 'Máquinas virtuales compartidas',
  'dashboard.newServer': 'Nuevo servidor',
};

// German
dicts.de = {
  'nav.menu': 'Menü',
  'nav.dashboard': 'Dashboard',
  'nav.server': 'Serververwaltung',
  'nav.overview': 'Übersicht',
  'nav.terminal': 'Terminal',
  'nav.files': 'Dateimanager',
  'nav.backups': 'Backups',
  'nav.schedules': 'Zeitpläne',
  'nav.startup': 'Start',
  'nav.settings': 'Einstellungen',
  'nav.subusers': 'Unterbenutzer',
  'nav.activity': 'Aktivität',
  'nav.personal': 'Personalisierung',
  'nav.profile': 'Profil',
  'nav.billing': 'Abrechnung',
  'nav.admin': 'Admin-Dashboard',
  'nav.nodes': 'Knoten & Live-Status',
  'nav.create': 'Server erstellen',
  'nav.users': 'Benutzerverwaltung',
  'nav.plans': 'Abrechnung & Pläne',
  'nav.templates': 'OS-Vorlagen',
  'nav.storage': 'Speicher & ISOs',
  'nav.network': 'Netzwerke & Firewall',
  'nav.activityLog': 'Aktivitätsprotokoll',
  'nav.updates': 'Update-Center',
  'nav.settingsMgmt': 'Einstellungsverwaltung',
  'nav.session': 'Sitzung',
  'nav.logout': 'Abmelden',
  'topbar.search': 'Server suchen...',
  'topbar.newServer': 'Neuer Server',
  'topbar.impersonation': 'Identitätswechsel-Sitzung aktiv',
  'topbar.returnAdmin': 'Zurück zum Admin',
  'common.back': 'Zurück',
  'common.save': 'Speichern',
  'common.cancel': 'Abbrechen',
  'common.delete': 'Löschen',
  'common.create': 'Erstellen',
  'common.refresh': 'Aktualisieren',
  'common.close': 'Schließen',
  'common.ok': 'OK',
  'common.enable': 'Aktivieren',
  'common.disable': 'Deaktivieren',
  'common.confirm': 'Bestätigen',
  'dashboard.title': 'Virtuelle Maschinen',
  'dashboard.empty': 'Stellen Sie Ihre erste virtuelle Maschine bereit, um mit sofortigen Cloud-Umgebungen zu starten.',
  'dashboard.deployFirst': 'Erste virtuelle Maschine bereitstellen',
  'dashboard.createVm': 'Virtuelle Maschine erstellen',
  'dashboard.shared': 'Gemeinsame virtuelle Maschinen',
  'dashboard.newServer': 'Neuer Server',
};

// Arabic
dicts.ar = {
  'nav.menu': 'القائمة',
  'nav.dashboard': 'لوحة التحكم',
  'nav.server': 'إدارة الخوادم',
  'nav.overview': 'نظرة عامة',
  'nav.terminal': 'الطرفية',
  'nav.files': 'مدير الملفات',
  'nav.backups': 'النسخ الاحتياطية',
  'nav.schedules': 'الجدولة',
  'nav.startup': 'بدء التشغيل',
  'nav.settings': 'الإعدادات',
  'nav.subusers': 'المستخدمون الفرعيون',
  'nav.activity': 'النشاط',
  'nav.personal': 'التخصيص',
  'nav.profile': 'الملف الشخصي',
  'nav.billing': 'الفواتير',
  'nav.admin': 'لوحة المشرف',
  'nav.nodes': 'العقد والحالة المباشرة',
  'nav.create': 'إنشاء خادم',
  'nav.users': 'إدارة المستخدمين',
  'nav.plans': 'الفواتير والخطط',
  'nav.templates': 'قوالب النظام',
  'nav.storage': 'التخزين والأيزو',
  'nav.network': 'الشبكات وجدار الحماية',
  'nav.activityLog': 'سجل النشاط',
  'nav.updates': 'مركز التحديثات',
  'nav.settingsMgmt': 'إدارة الإعدادات',
  'nav.session': 'الجلسة',
  'nav.logout': 'تسجيل الخروج',
  'topbar.search': 'ابحث عن الخوادم...',
  'topbar.newServer': 'خادم جديد',
  'topbar.impersonation': 'جلسة انتحال الهوية نشطة',
  'topbar.returnAdmin': 'العودة إلى المشرف',
  'common.back': 'رجوع',
  'common.save': 'حفظ',
  'common.cancel': 'إلغاء',
  'common.delete': 'حذف',
  'common.create': 'إنشاء',
  'common.refresh': 'تحديث',
  'common.close': 'إغلاق',
  'common.ok': 'موافق',
  'common.enable': 'تفعيل',
  'common.disable': 'تعطيل',
  'common.confirm': 'تأكيد',
  'dashboard.title': 'الأجهزة الافتراضية',
  'dashboard.empty': 'انشر أول جهاز افتراضي لك للبدء مع بيئات سحابية فورية.',
  'dashboard.deployFirst': 'انشر أول جهاز افتراضي',
  'dashboard.createVm': 'إنشاء جهاز افتراضي',
  'dashboard.shared': 'الأجهزة الافتراضية المشتركة',
  'dashboard.newServer': 'خادم جديد',
};

function t(lang, key, vars) {
  const table = dicts[lang] || {};
  let s = table[key];
  if (s === undefined) s = en[key];
  if (s === undefined) s = key;
  if (vars) {
    s = String(s).replace(/\{(\w+)\}/g, (_, k) => (vars[k] !== undefined ? String(vars[k]) : '{' + k + '}'));
  }
  return s;
}

function validLang(code) {
  return LANGUAGES.some((l) => l.code === code);
}

function langFor(user, settings) {
  if (user && user.language && validLang(user.language)) return user.language;
  const def = settings && settings['panel.language'];
  if (def && validLang(def)) return def;
  return 'en';
}

function tFor(lang) {
  return (key, vars) => t(lang, key, vars);
}

function dirFor(lang) {
  return RTL.has(lang) ? 'rtl' : 'ltr';
}

// Middleware helper: attach t/lang/uiDir to res.locals
function i18nMiddleware(req, res, next) {
  const { settings } = require('./db');
  const lang = langFor(req.user || null, settings.all());
  res.locals.lang = lang;
  res.locals.uiDir = dirFor(lang);
  res.locals.t = tFor(lang);
  next();
}

module.exports = { LANGUAGES, t, tFor, dirFor, validLang, langFor, i18nMiddleware };