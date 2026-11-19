package com.office.snacks.entity;

import jakarta.persistence.*;
import java.time.Instant;

@Entity @Table(name="snack_records", indexes={@Index(name="idx_records_taken_at",columnList="taken_at"),@Index(name="idx_records_employee_time",columnList="employee_id,taken_at"),@Index(name="idx_records_snack_time",columnList="snack_id,taken_at")})
public class SnackRecord {
    @Id @GeneratedValue(strategy=GenerationType.IDENTITY) private Long id;
    @ManyToOne(fetch=FetchType.LAZY,optional=false) @JoinColumn(name="employee_id",nullable=false) private Employee employee;
    @ManyToOne(fetch=FetchType.LAZY,optional=false) @JoinColumn(name="snack_id",nullable=false) private Snack snack;
    @Column(nullable=false) private int quantity;
    @Column(name="taken_at",nullable=false,updatable=false) private Instant takenAt=Instant.now();
    protected SnackRecord(){}
    public SnackRecord(Employee employee, Snack snack, int quantity){this.employee=employee;this.snack=snack;this.quantity=quantity;}
    public Long getId(){return id;} public Employee getEmployee(){return employee;} public Snack getSnack(){return snack;} public int getQuantity(){return quantity;} public Instant getTakenAt(){return takenAt;}
    public void updateSelection(Employee employee, Snack snack, int quantity){this.employee=employee;this.snack=snack;this.quantity=quantity;}
}
