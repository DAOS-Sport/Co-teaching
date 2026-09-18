import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
const ref = process.argv[2];
if (!ref || ref.startsWith('-')) throw new Error('Pass the captured-source commit SHA');
const manifest=JSON.parse(readFileSync('provenance/production-20260918.json','utf8'));
const mismatches=[];
for(const [file,expected] of Object.entries(manifest.files)) {
  const bytes=execFileSync('git',['show',`${ref}:${file}`],{maxBuffer:10_000_000});
  if(createHash('sha256').update(bytes).digest('hex')!==expected.sha256) mismatches.push(file);
}
console.log(JSON.stringify({ref,checked:Object.keys(manifest.files).length,mismatches}));
if(mismatches.length) process.exitCode=1;
