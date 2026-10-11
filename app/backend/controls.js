const fs = require("fs/promises");

const PLATFORM_PROFILE = "/sys/firmware/acpi/platform_profile";
const PLATFORM_PROFILE_CHOICES = "/sys/firmware/acpi/platform_profile_choices";
const SENSE_DIRS = ["/sys/devices/platform/acer-wmi/nitro_sense", "/sys/devices/platform/acer-wmi/predator_sense"];

async function write(file, value) {
  try {
    await fs.writeFile(file, `${value}\n`);
  } catch (error) {
    if (error.code === "EACCES") throw new Error(`No permission to write ${file}. Run install.sh to grant the linuwu_sense group access.`);
    throw new Error(`Driver rejected ${value}: ${error.message}`);
  }
}

async function senseFile(name) {
  for (const dir of SENSE_DIRS) {
    try {
      await fs.access(`${dir}/${name}`);
      return `${dir}/${name}`;
    } catch {
      // try the next layout
    }
  }
  throw new Error("linuwu-sense controls are not available");
}

async function setProfile(profile) {
  const choices = (await fs.readFile(PLATFORM_PROFILE_CHOICES, "utf8")).trim().split(/\s+/);
  if (!choices.includes(profile)) throw new Error(`Unsupported power mode: ${profile}`);
  await write(PLATFORM_PROFILE, profile);
}

// 0,0 = automatic, 100,100 = maximum, anything else = custom percentages.
async function setFanSpeed(cpu, gpu) {
  const values = [cpu, gpu].map((v) => Math.round(Number(v)));
  if (values.some((v) => !Number.isFinite(v) || v < 0 || v > 100)) throw new Error("Fan speeds must be 0-100%");
  await write(await senseFile("fan_speed"), values.join(","));
}

module.exports = { setProfile, setFanSpeed };
