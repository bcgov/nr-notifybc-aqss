/*
 * NANP audit for SMS subscriptions -- READ ONLY, makes no changes.
 *
 * Classifies every channel:'sms' subscription against the NANP rules:
 *   - 10 digits
 *   - 1st digit (area code) must be 2-9
 *   - 4th digit (central office code) must be 2-9
 *   - all other digits 0-9
 *
 * Run against the mongo pod (nothing is copied to the pod -- the script is
 * piped into the shell over stdin):
 *
 *   oc -n ef3999-prod rsh mongodb2-5-r4r4s bash -c \
 *     'mongo -u "$MONGODB_USER" -p "$MONGODB_PASSWORD" "$MONGODB_DATABASE" --quiet' \
 *     < utils/nanp/nanp-audit.js
 *
 * Add `> nanp-audit.txt` to keep a copy of the report.
 *
 * Written in ES5 for compatibility with the legacy `mongo` shell.
 */

// ---------------------------------------------------------------- NANP rules

var NANP_CANONICAL = /^[2-9][0-9]{2}-[2-9][0-9]{2}-[0-9]{4}$/; // stored form
var NANP_DIGITS = /^[2-9][0-9]{2}[2-9][0-9]{6}$/; // bare 10 digits

// Reduce a stored value to its 10 NANP digits, or return null if it can't be one.
function toNanpDigits(value) {
  if (typeof value !== 'string') {
    return null;
  }
  var digits = value.replace(/[^0-9]/g, '');
  // tolerate a country code: 1-604-210-9276, +16042109276, 16042109276
  if (digits.length === 11 && digits.charAt(0) === '1') {
    digits = digits.substring(1);
  }
  return NANP_DIGITS.test(digits) ? digits : null;
}

function toCanonical(digits) {
  return (
    digits.substring(0, 3) + '-' + digits.substring(3, 6) + '-' + digits.substring(6)
  );
}

// Explain, in plain language, why a value is not a NANP number.
function explain(value) {
  if (typeof value !== 'string' || value === '') {
    return 'empty or non-string value';
  }
  var digits = value.replace(/[^0-9]/g, '');
  if (digits.length === 11 && digits.charAt(0) === '1') {
    digits = digits.substring(1);
  }
  if (digits.length !== 10) {
    return 'has ' + digits.length + ' digits, needs 10';
  }
  var reasons = [];
  if (/^[01]/.test(digits)) {
    reasons.push('area code starts with ' + digits.charAt(0));
  }
  if (/^[01]/.test(digits.substring(3))) {
    reasons.push('exchange code starts with ' + digits.charAt(3));
  }
  return reasons.length ? reasons.join('; ') : 'fails NANP pattern';
}

// ------------------------------------------------------------------- scan

// First pass: record the canonical numbers already present, per service, so a
// value that would merely be reformatted onto an existing subscription can be
// reported as a duplicate rather than as a reformat.
var seen = {};
var preScan = db.subscription.find({ channel: 'sms' });
while (preScan.hasNext()) {
  var pre = preScan.next();
  if (typeof pre.userChannelId === 'string' && NANP_CANONICAL.test(pre.userChannelId)) {
    seen[(pre.serviceName || '') + '|' + pre.userChannelId] = true;
  }
}

var cursor = db.subscription.find({ channel: 'sms' });

var counts = { total: 0, ok: 0, normalizable: 0, duplicate: 0, invalid: 0 };
var normalizable = [];
var duplicate = [];
var invalid = [];

while (cursor.hasNext()) {
  var doc = cursor.next();
  counts.total++;

  var raw = doc.userChannelId;
  if (typeof raw === 'string' && NANP_CANONICAL.test(raw)) {
    counts.ok++;
    continue;
  }

  var digits = toNanpDigits(raw);
  var row = {
    id: String(doc._id),
    state: doc.state || '(none)',
    service: doc.serviceName || '(none)',
    created: doc.created ? new Date(doc.created).toISOString().substring(0, 10) : '',
    stored: raw === undefined ? '(missing)' : String(raw),
  };

  if (digits) {
    row.becomes = toCanonical(digits);
    var key = (doc.serviceName || '') + '|' + row.becomes;
    if (seen[key]) {
      counts.duplicate++;
      duplicate.push(row);
    } else {
      seen[key] = true;
      counts.normalizable++;
      normalizable.push(row);
    }
  } else {
    counts.invalid++;
    row.reason = explain(raw);
    invalid.push(row);
  }
}

// ----------------------------------------------------------------- report

function pad(s, n) {
  s = String(s);
  while (s.length < n) {
    s = s + ' ';
  }
  return s;
}

function byState(rows) {
  var tally = {};
  for (var i = 0; i < rows.length; i++) {
    tally[rows[i].state] = (tally[rows[i].state] || 0) + 1;
  }
  var parts = [];
  for (var k in tally) {
    parts.push(k + '=' + tally[k]);
  }
  return parts.length ? parts.join(', ') : 'none';
}

print('');
print('=========================================================================');
print('  NANP audit of SMS subscriptions  (read only -- nothing was changed)');
print('  database: ' + db.getName());
print('=========================================================================');
print('');
print('  total sms subscriptions ......... ' + counts.total);
print('  already valid (###-###-####) .... ' + counts.ok);
print('  valid number, wrong format ...... ' + counts.normalizable + '   -> can be reformatted, keeps subscriber');
print('  duplicate once reformatted ...... ' + counts.duplicate + '   -> same number already subscribed');
print('  not a NANP number ............... ' + counts.invalid + '   -> candidates for deletion');
print('');

print('-------------------------------------------------------------------------');
print('  B. VALID NUMBER, WRONG FORMAT  (' + counts.normalizable + ')');
print('     Real NANP numbers stored with a country code, spaces, brackets etc.');
print('     Recommend reformatting these rather than deleting.');
print('     by state: ' + byState(normalizable));
print('-------------------------------------------------------------------------');
if (normalizable.length === 0) {
  print('  (none)');
} else {
  print(
    '  ' + pad('stored', 24) + pad('becomes', 16) + pad('state', 13) + pad('created', 12) + 'id'
  );
  for (var i = 0; i < normalizable.length; i++) {
    var n = normalizable[i];
    print(
      '  ' + pad(n.stored, 24) + pad(n.becomes, 16) + pad(n.state, 13) + pad(n.created, 12) + n.id
    );
  }
}
print('');

print('-------------------------------------------------------------------------');
print('  C. DUPLICATE ONCE REFORMATTED  (' + counts.duplicate + ')');
print('     The same number is already subscribed to the same service in');
print('     canonical form. Reformatting would double-send, so these are');
print('     removed rather than reformatted.');
print('     by state: ' + byState(duplicate));
print('-------------------------------------------------------------------------');
if (duplicate.length === 0) {
  print('  (none)');
} else {
  print(
    '  ' + pad('stored', 24) + pad('duplicate of', 16) + pad('state', 13) + pad('created', 12) + 'id'
  );
  for (var d = 0; d < duplicate.length; d++) {
    var dup = duplicate[d];
    print(
      '  ' + pad(dup.stored, 24) + pad(dup.becomes, 16) + pad(dup.state, 13) + pad(dup.created, 12) + dup.id
    );
  }
}
print('');

print('-------------------------------------------------------------------------');
print('  D. NOT A NANP NUMBER  (' + counts.invalid + ')');
print('     These cannot be dialled. Deleting them is the proposed action.');
print('     by state: ' + byState(invalid));
print('-------------------------------------------------------------------------');
if (invalid.length === 0) {
  print('  (none)');
} else {
  print(
    '  ' + pad('stored', 24) + pad('state', 13) + pad('created', 12) + pad('reason', 34) + 'id'
  );
  for (var j = 0; j < invalid.length; j++) {
    var v = invalid[j];
    print(
      '  ' + pad(v.stored, 24) + pad(v.state, 13) + pad(v.created, 12) + pad(v.reason, 34) + v.id
    );
  }
}
print('');
print('=========================================================================');
print('  Nothing has been modified. Review lists B, C and D above, then run');
print('  utils/nanp/nanp-cleanup.js to apply changes.');
print('=========================================================================');
print('');
