const fs = require("node:fs");
const path = require("node:path");
const ResEdit = require("resedit");

/**
 * electron-builder собирает Windows-zip на Linux и не вызывает rcedit
 * (signAndEditExecutable: false), поэтому .exe остаётся с иконкой Electron.
 * resedit — чистый JS, ему не нужен Wine: подменяем группу иконок прямо в PE.
 *
 * Хук вызывается после упаковки приложения до создания zip.
 */
module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== "win32") return;

  const exePath = path.join(
    context.appOutDir,
    context.packager.appInfo.productFilename + ".exe"
  );
  if (!fs.existsSync(exePath)) return;

  const iconPath = path.join(context.packager.projectDir, "assets", "icon.ico");
  if (!fs.existsSync(iconPath)) {
    throw new Error("Не найдена иконка приложения: " + iconPath);
  }

  const executable = ResEdit.NtExecutable.from(fs.readFileSync(exePath), { ignoreCert: true });
  const resources = ResEdit.NtExecutableResource.from(executable);
  const groups = ResEdit.Resource.IconGroupEntry.fromEntries(resources.entries);
  const iconFile = ResEdit.Data.IconFile.from(fs.readFileSync(iconPath));
  const icons = iconFile.icons.map((item) => item.data);

  if (!groups.length) {
    throw new Error("В " + exePath + " нет группы иконок");
  }

  // В Electron-сборке группа одна (ID 1, en-US), но не привязываемся к номеру:
  // заменяем все найденные группы, чтобы иконка была одинаковой везде.
  for (const group of groups) {
    ResEdit.Resource.IconGroupEntry.replaceIconsForResource(
      resources.entries,
      group.id,
      group.lang,
      icons
    );
  }

  resources.outputResource(executable);
  fs.writeFileSync(exePath, Buffer.from(executable.generate()));
};
