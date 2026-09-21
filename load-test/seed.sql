-- 부하 테스트용 마스터 데이터 시드. run-load.sh 가 docker exec 로 실행한다.
-- ${TOTAL_INVENTORY} 는 sed 로 치환된다.
--
-- 멱등성: 매 run 마다 user_coupon / outbox_event 는 비우고 inventory 는 reset.
-- event / coupon_type 은 처음 한 번만 생성.

USE server_c;

DELETE FROM user_coupon;
DELETE FROM outbox_event;

-- 시간 윈도우를 매 run 마다 재설정 (volume 이 살아있을 때 stale 방지).
INSERT INTO event (event_id, name, content, started_at, ended_at, status)
    VALUES (1, 'load-test', 'k6 load', NOW(3) - INTERVAL 1 HOUR, NOW(3) + INTERVAL 1 HOUR, 'IN_PROGRESS')
    ON DUPLICATE KEY UPDATE
        started_at = NOW(3) - INTERVAL 1 HOUR,
        ended_at   = NOW(3) + INTERVAL 1 HOUR,
        status     = 'IN_PROGRESS';

INSERT IGNORE INTO coupon_type (coupon_type_id, event_id, name, discount_rate)
    VALUES (1, 1, '10pct', 10);

INSERT INTO coupon_type_inventory (event_id, coupon_type_id, total_inventory, available_count)
    VALUES (1, 1, ${TOTAL_INVENTORY}, ${TOTAL_INVENTORY})
    ON DUPLICATE KEY UPDATE
        total_inventory = ${TOTAL_INVENTORY},
        available_count = ${TOTAL_INVENTORY};
