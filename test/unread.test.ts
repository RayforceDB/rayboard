import {expect,test} from 'bun:test';
import {changed, unreadCount} from '../ui/unread';
test('only actual later messages are unread; a snapshot cannot mark newer unseen activity read',()=>{
  expect(changed({last:12,last_author:'other'},11,'me')).toBe(true);
  expect(changed({last:12,last_author:'me'},0,'me')).toBe(false);
  expect(changed({last:12,last_author:'other'},12,'me')).toBe(false);
  // What GitHub sync alone did is nobody's news (T-20): 410 imports must not read as 410 changes.
  expect(changed({last:12,last_author:'github'},0,'me')).toBe(false);
  expect(changed({last:11,last_author:'other'},12,'me')).toBe(false);
  expect(unreadCount([{id:'T-1',last:12,last_author:'other'},{id:'T-2',last:5,last_author:'me'}],{'T-1':11},'me')).toBe(1);
});
