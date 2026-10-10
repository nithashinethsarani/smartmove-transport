ALTER TABLE TICKET DROP CONSTRAINT UQ_TICKET_SEAT;

CREATE UNIQUE INDEX UQ_TICKET_ACTIVE_SEAT ON TICKET (
  CASE WHEN STATUS <> 'Cancelled' THEN TRIP_ID END,
  CASE WHEN STATUS <> 'Cancelled' THEN SEAT_NUMBER END);

CREATE SEQUENCE SEQ_TICKET START WITH 100;

CREATE OR REPLACE PROCEDURE sp_add_new_ticket (
    p_trip_id      IN  VARCHAR2,
    p_passenger_id IN  VARCHAR2,
    p_seat_number  IN  VARCHAR2,
    p_ticket_id    OUT VARCHAR2
) AS
    v_cnt    NUMBER;
    v_status TRIP.STATUS%TYPE;
    v_price  TRIP.PRICE%TYPE;
    v_cap    VEHICLE.CAPACITY%TYPE;
    v_idx    NUMBER;
    
    
BEGIN
    SELECT COUNT(*) INTO v_cnt FROM PASSENGER WHERE PASSENGER_ID = p_passenger_id;
    IF v_cnt = 0 THEN RAISE_APPLICATION_ERROR(-20010, 'Passenger not found.'); END IF;

    BEGIN
        SELECT t.STATUS, t.PRICE, v.CAPACITY INTO v_status, v_price, v_cap
        FROM TRIP t JOIN VEHICLE v ON v.VEHICLE_ID = t.VEHICLE_ID
        WHERE t.TRIP_ID = p_trip_id;
    EXCEPTION WHEN NO_DATA_FOUND THEN
        RAISE_APPLICATION_ERROR(-20011, 'Trip not found.');
    END;

    IF v_status <> 'Scheduled' THEN
        RAISE_APPLICATION_ERROR(-20012, 'This trip is not open for booking.');
    END IF;

    IF p_seat_number IS NULL OR NOT REGEXP_LIKE(p_seat_number, '^[A-P]0[1-4]$') THEN
        RAISE_APPLICATION_ERROR(-20014, 'Invalid seat number.');
    END IF;
    v_idx := (ASCII(SUBSTR(p_seat_number,1,1)) - 65) * 4 + TO_NUMBER(SUBSTR(p_seat_number,2));
    IF v_idx > v_cap THEN
        RAISE_APPLICATION_ERROR(-20014, 'This seat does not exist in this vehicle.');
    END IF;

    p_ticket_id := 'TK' || LPAD(SEQ_TICKET.NEXTVAL, 3, '0');
    INSERT INTO TICKET (TICKET_ID, TRIP_ID, PASSENGER_ID, BOOKING_DATE, SEAT_NUMBER, TICKET_PRICE, STATUS)
    VALUES (p_ticket_id, p_trip_id, p_passenger_id, SYSDATE, p_seat_number, v_price, 'Confirmed');
    COMMIT;
EXCEPTION
    WHEN DUP_VAL_ON_INDEX THEN
        ROLLBACK;
        RAISE_APPLICATION_ERROR(-20013, 'Seat ' || p_seat_number || ' is already booked.');
END;





SELECT OBJECT_NAME, STATUS FROM USER_OBJECTS
WHERE OBJECT_NAME IN ('SP_ADD_NEW_TICKET','UQ_TICKET_ACTIVE_SEAT','SEQ_TICKET');




DECLARE v VARCHAR2(20);
BEGIN sp_add_new_ticket('T011', 'P001', 'A02', v); END;


SELECT PASSENGER_ID, FIRST_NAME, EMAIL FROM PASSENGER ORDER BY PASSENGER_ID;

INSERT INTO TICKET (TICKET_ID,TRIP_ID,PASSENGER_ID,BOOKING_DATE,SEAT_NUMBER,TICKET_PRICE,STATUS)
VALUES ('TK901','T008','P008',DATE '2026-08-30','A03',600,'Confirmed');
COMMIT;


   SELECT * FROM FEEDBACK WHERE FEEDBACK_ID = 'F014';