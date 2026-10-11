#!/usr/bin/env python3
"""Create a deterministic read-only GitHub runner for the owned Git fixture."""
from pathlib import Path
import json
root=Path('/tmp/workbench-pr-e2e')
assert not root.is_symlink()
repo=Path('/tmp/workbench-e2e/project/repos/other')
assert (repo/'.git').is_dir() and not repo.is_symlink()
root.mkdir(exist_ok=True)
base='0'*40;head='2'*40;tip='3'*40
files=[{'filename':'src/review.js','status':'modified','additions':1,'deletions':1},{'filename':'docs/new.md','status':'added','additions':1,'deletions':0},{'filename':'docs/removed.md','status':'removed','additions':0,'deletions':1},{'filename':'src/new-name.js','previous_filename':'src/old-name.js','status':'renamed','additions':1,'deletions':1},{'filename':'assets/logo.png','status':'modified','additions':0,'deletions':0}]
contents={base:{'src/review.js':"export const review = 'base PR version';\n",'docs/removed.md':'removed PR content\n','src/old-name.js':'old renamed PR content\n','assets/logo.png':'\x00binary base'},head:{'src/review.js':"export const review = 'head PR version';\n",'docs/new.md':'# Added by the pull request\n','src/new-name.js':'new renamed PR content\n','assets/logo.png':'\x00binary head'}}
(root/'data.json').write_text(json.dumps({'base':base,'head':head,'tip':tip,'files':files,'contents':contents}))
runner=r'''#!/usr/bin/env python3
import json,os,sys,urllib.parse
from pathlib import Path
root=Path('/tmp/workbench-pr-e2e');data=json.loads((root/'data.json').read_text())
tool,repo,*args=sys.argv[1:]
if tool=='git':os.execv('/tmp/workbench-git-e2e/runner',['/tmp/workbench-git-e2e/runner',tool,repo,*args])
if tool!='gh' or repo not in ['/tmp/workbench-e2e/project/repos/other','/tmp/workbench-e2e/project/repos/other/deep/leaf']:sys.exit(64)
with (root/'calls.jsonl').open('a') as f:f.write(json.dumps(args)+'\n')
if args[:2]==['auth','status']:print('Logged in as owned fixture');sys.exit()
if args[:2]==['pr','view']:
 print(json.dumps({'number':4242,'title':'PR review fixture','url':'https://github.com/example/workbench/pull/4242','state':'OPEN','isDraft':False,'baseRefName':'main','headRefName':'workbench-fixture','headRefOid':data['head'],'headRepositoryOwner':{'login':'fork-owner'},'reviewDecision':'APPROVED','statusCheckRollup':[],'updatedAt':'2026-10-08T00:00:00Z'}));sys.exit()
endpoint=next((v for v in args if v.startswith('repos/')),None)
if args and args[0]=='api' and endpoint:
 parsed=urllib.parse.urlsplit(endpoint);path=parsed.path;query=urllib.parse.parse_qs(parsed.query)
 if '/compare/' in path:
  if '--jq' in args and args[args.index('--jq')+1]=='.merge_base_commit.sha':print(data['base'])
  elif '--jq' in args and args[args.index('--jq')+1]=='{merge_base_sha:.merge_base_commit.sha,base_sha:.base_commit.sha}':print(json.dumps({'merge_base_sha':data['base'],'base_sha':data['tip']}))
  else:sys.stderr.write('Unsupported compare projection; GitHub has no head_commit field\n');sys.exit(64)
  sys.exit()
 if path.endswith('/pulls/4242/files'):
  print(json.dumps(data['files'] if query.get('page',['1'])[0]=='1' else []));sys.exit()
 if path.endswith('/pulls/4242'):
  print(json.dumps({'number':4242,'state':'open','html_url':'https://github.com/example/workbench/pull/4242','base':{'sha':data['tip'],'ref':'main','repo':{'full_name':'example/workbench'}},'head':{'sha':data['head'],'ref':'workbench-fixture','repo':{'full_name':'fork-owner/workbench'}}}));sys.exit()
 if '/contents/' in path:
  rel=urllib.parse.unquote(path.split('/contents/',1)[1]);ref=query.get('ref',[''])[0]
  expected='example/workbench' if ref==data['base'] else 'fork-owner/workbench'
  if not path.startswith('repos/'+expected+'/contents/') or ref not in data['contents'] or rel not in data['contents'][ref]:sys.stderr.write('Not found in exact PR commit\n');sys.exit(1)
  sys.stdout.buffer.write(data['contents'][ref][rel].encode());sys.exit()
sys.stderr.write('Unsupported owned GitHub fixture request\n');sys.exit(64)
'''
(root/'runner').write_text(runner);(root/'runner').chmod(0o700)
(repo/'src').mkdir(exist_ok=True);(repo/'src'/'review.js').write_text('LOCAL_WORKING_TREE_MUST_NOT_APPEAR_IN_PR_DIFF\n')
print('Owned PR fixture runner:',root/'runner')
