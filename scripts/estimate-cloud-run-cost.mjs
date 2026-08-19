const cpu = parsePositiveNumber(process.env.CPU ?? '1', 'CPU');
const memory = parseMemoryGiB(process.env.MEMORY_GIB ?? process.env.MEMORY ?? '1');
const tasks = parsePositiveInteger(process.env.TASKS ?? '1', 'TASKS');
const parallelism = parsePositiveInteger(process.env.PARALLELISM ?? '1', 'PARALLELISM');
const totalAccounts = parseOptionalPositiveInteger(process.env.TOTAL_ACCOUNTS ?? '');
const avgSecondsPerAccount = parseOptionalPositiveNumber(process.env.AVG_SECONDS_PER_ACCOUNT ?? '');

const cpuRate = 0.000018;
const memoryRate = 0.000002;
const concurrentTasks = Math.min(tasks, parallelism);
const perTaskSecond = cpu * cpuRate + memory * memoryRate;
const perTaskHour = perTaskSecond * 3600;
const peakHourlyBurn = concurrentTasks * perTaskHour;

const lines = [
  `Cloud Run unit cost: $${perTaskSecond.toFixed(8)} per task-second`,
  `Cloud Run unit cost: $${perTaskHour.toFixed(4)} per task-hour`,
  `Peak hourly burn at current concurrency: $${peakHourlyBurn.toFixed(2)} / hour`,
];

if (totalAccounts !== undefined && avgSecondsPerAccount !== undefined) {
  const estimatedTotalCost = totalAccounts * avgSecondsPerAccount * perTaskSecond;
  lines.push(`Estimated total cost for ${totalAccounts} accounts at ${avgSecondsPerAccount} seconds/account: $${estimatedTotalCost.toFixed(2)}`);
}

process.stdout.write(`${lines.join('\n')}\n`);

function parsePositiveNumber(value, name) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive number. Got "${value}".`);
  }
  return parsed;
}

function parsePositiveInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer. Got "${value}".`);
  }
  return parsed;
}

function parseMemoryGiB(value) {
  const trimmed = value.trim();
  const match = /^(\d+(?:\.\d+)?)(Mi|Gi|MiB|GiB)?$/i.exec(trimmed);
  if (!match) {
    throw new Error(`MEMORY must be a number or a Mi/Gi quantity. Got "${value}".`);
  }

  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error(`MEMORY must be positive. Got "${value}".`);
  }

  const unit = (match[2] ?? 'Gi').toLowerCase();
  if (unit.startsWith('mi')) {
    return amount / 1024;
  }

  return amount;
}

function parseOptionalPositiveNumber(value) {
  if (!value.trim()) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`AVG_SECONDS_PER_ACCOUNT must be a positive number. Got "${value}".`);
  }
  return parsed;
}

function parseOptionalPositiveInteger(value) {
  if (!value.trim()) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`TOTAL_ACCOUNTS must be a positive integer. Got "${value}".`);
  }
  return parsed;
}
