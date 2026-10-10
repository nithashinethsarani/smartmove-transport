--------------------- Procedure--------------------
CREATE OR REPLACE PROCEDURE sp_add_new_ticket (
    p_ticket_id    IN TICKET.TICKET_ID%TYPE,
    p_trip_id      IN TICKET.TRIP_ID%TYPE,
    p_passenger_id IN TICKET.PASSENGER_ID%TYPE,
    p_seat_number  IN TICKET.SEAT_NUMBER%TYPE,
    p_price        IN TICKET.TICKET_PRICE%TYPE
) AS
    v_passenger_exists NUMBER;
    v_trip_exists      NUMBER;
    ex_invalid_data    EXCEPTION;
BEGIN
   
    SELECT COUNT(*) INTO v_passenger_exists FROM PASSENGER WHERE PASSENGER_ID = p_passenger_id;
    SELECT COUNT(*) INTO v_trip_exists FROM TRIP WHERE TRIP_ID = p_trip_id;

    IF v_passenger_exists = 0 OR v_trip_exists = 0 THEN
        RAISE ex_invalid_data;
    END IF;

   
    INSERT INTO TICKET (TICKET_ID, TRIP_ID, PASSENGER_ID, BOOKING_DATE, SEAT_NUMBER, TICKET_PRICE, STATUS)
    VALUES (p_ticket_id, p_trip_id, p_passenger_id, SYSDATE, p_seat_number, p_price, 'Confirmed');

    COMMIT;
    DBMS_OUTPUT.PUT_LINE('Success: Ticket ' || p_ticket_id || ' booked successfully.');

EXCEPTION
    WHEN DUP_VAL_ON_INDEX THEN
        DBMS_OUTPUT.PUT_LINE('Error: Ticket ID ' || p_ticket_id || ' already exists!');
    WHEN ex_invalid_data THEN
        DBMS_OUTPUT.PUT_LINE('Error: Invalid Passenger ID or Trip ID provided.');
    WHEN OTHERS THEN
        DBMS_OUTPUT.PUT_LINE('Error: ' || SQLERRM);
        ROLLBACK;
END;




----------------Function-------Total Revenue from a Passenger----------------------
CREATE OR REPLACE FUNCTION fn_get_passenger_total_paid (
    p_passenger_id IN PASSENGER.PASSENGER_ID%TYPE
) RETURN NUMBER IS
    v_total_paid NUMBER := 0;
BEGIN
    SELECT NVL(SUM(p.AMOUNT), 0)
    INTO v_total_paid
    FROM PAYMENT p
    JOIN TICKET t ON p.TICKET_ID = t.TICKET_ID
    WHERE t.PASSENGER_ID = p_passenger_id
      AND p.PAYMENT_STATUS = 'Paid';

    RETURN v_total_paid;
EXCEPTION
    WHEN OTHERS THEN
        RETURN 0;
END;




---------Cursor-------
DECLARE
    CURSOR c_available_vehicles IS
        SELECT VEHICLE_ID, VEHICLE_NUMBER, VEHICLE_TYPE, MODEL, CAPACITY, STATUS
        FROM VEHICLE
        WHERE STATUS = 'Available';
        
    v_veh c_available_vehicles%ROWTYPE;
BEGIN
    OPEN c_available_vehicles;
    LOOP
        FETCH c_available_vehicles INTO v_veh;
        EXIT WHEN c_available_vehicles%NOTFOUND;
        
        DBMS_OUTPUT.PUT_LINE('Vehicle ID: ' || v_veh.VEHICLE_ID || 
                             ' | No: ' || v_veh.VEHICLE_NUMBER || 
                             ' | Type: ' || v_veh.VEHICLE_TYPE || 
                             ' | Model: ' || v_veh.MODEL);
    END LOOP;
    CLOSE c_available_vehicles;
END;





--------Trigger---------------

CREATE OR REPLACE TRIGGER trg_after_ticket_insert
AFTER INSERT ON TICKET
FOR EACH ROW
DECLARE
    v_next_pm_id VARCHAR2(10);
BEGIN
    -- Example for Generating Payment ID dynamically or inserting pending record
    v_next_pm_id := 'PM' || LPAD(TO_NUMBER(SUBSTR(:NEW.TICKET_ID, 3)) + 10, 3, '0');

    INSERT INTO PAYMENT (PAYMENT_ID, TICKET_ID, PAYMENT_DATE, AMOUNT, PAYMENT_METHOD, PAYMENT_STATUS)
    VALUES (
        v_next_pm_id,
        :NEW.TICKET_ID,
        SYSDATE,
        :NEW.TICKET_PRICE,
        'Pending',
        'Pending'
    );
END;








-----------Report 1 — Most Frequently Used Routes-------------
SELECT 
    r.ROUTE_ID,
    r.ROUTE_NAME,
    r.START_LOCATION,
    r.END_LOCATION,
    COUNT(tk.TICKET_ID) AS TOTAL_BOOKINGS
FROM ROUTE r
JOIN TRIP t ON r.ROUTE_ID = t.ROUTE_ID
LEFT JOIN TICKET tk ON t.TRIP_ID = tk.TRIP_ID
GROUP BY r.ROUTE_ID, r.ROUTE_NAME, r.START_LOCATION, r.END_LOCATION
ORDER BY TOTAL_BOOKINGS DESC;




-------Report 2 — Total Revenue---------

SELECT 
    TO_CHAR(PAYMENT_DATE, 'YYYY-MM') AS PAYMENT_MONTH,
    PAYMENT_METHOD,
    COUNT(PAYMENT_ID) AS TOTAL_TRANSACTIONS,
    SUM(AMOUNT) AS TOTAL_REVENUE
FROM PAYMENT
WHERE PAYMENT_STATUS = 'Paid'
GROUP BY TO_CHAR(PAYMENT_DATE, 'YYYY-MM'), PAYMENT_METHOD
ORDER BY PAYMENT_MONTH DESC;





------Report 3 — Passenger Travel History--------
SELECT 
    p.PASSENGER_ID,
    p.FIRST_NAME || ' ' || p.LAST_NAME AS PASSENGER_NAME,
    tk.TICKET_ID,
    r.ROUTE_NAME,
    t.TRIP_DATE,
    t.DEPARTURE_TIME,
    tk.SEAT_NUMBER,
    tk.TICKET_PRICE,
    tk.STATUS AS TICKET_STATUS
FROM PASSENGER p
JOIN TICKET tk ON p.PASSENGER_ID = tk.PASSENGER_ID
JOIN TRIP t ON tk.TRIP_ID = t.TRIP_ID
JOIN ROUTE r ON t.ROUTE_ID = r.ROUTE_ID
ORDER BY t.TRIP_DATE DESC, tk.TICKET_ID ASC;







-----------Report 4 — Vehicles Due for Maintenance-------------

SELECT 
    v.VEHICLE_ID,
    v.VEHICLE_NUMBER,
    v.VEHICLE_TYPE,
    v.MODEL,
    NVL(TO_CHAR(MAX(m.MAINTENANCE_DATE), 'DD-MON-YYYY'), 'No Maintenance Record') AS LAST_MAINTENANCE_DATE,
    v.STATUS
FROM VEHICLE v
LEFT JOIN MAINTENANCE m ON v.VEHICLE_ID = m.VEHICLE_ID
GROUP BY v.VEHICLE_ID, v.VEHICLE_NUMBER, v.VEHICLE_TYPE, v.MODEL, v.STATUS
HAVING MAX(m.MAINTENANCE_DATE) IS NULL 
    OR MAX(m.MAINTENANCE_DATE) < ADD_MONTHS(SYSDATE, -3)
ORDER BY v.VEHICLE_ID;






---------Report 5 — Driver / Vehicle Performance------------

SELECT 
    d.DRIVER_ID,
    d.FIRST_NAME || ' ' || d.LAST_NAME AS DRIVER_NAME,
    v.VEHICLE_ID,
    v.VEHICLE_NUMBER,
    COUNT(DISTINCT t.TRIP_ID) AS TOTAL_TRIPS_COMPLETED,
    NVL(ROUND(AVG(f.RATING), 2), 0) AS AVERAGE_RATING
FROM DRIVER d
JOIN TRIP t ON d.DRIVER_ID = t.DRIVER_ID
JOIN VEHICLE v ON t.VEHICLE_ID = v.VEHICLE_ID
LEFT JOIN FEEDBACK f ON t.TRIP_ID = f.TRIP_ID
GROUP BY d.DRIVER_ID, d.FIRST_NAME, d.LAST_NAME, v.VEHICLE_ID, v.VEHICLE_NUMBER
ORDER BY AVERAGE_RATING DESC, TOTAL_TRIPS_COMPLETED DESC;